import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Sandbox } from "@daytona/sdk";
import type { EngineRunContext } from "./types";
import { ensureRepoClone, prepareRepos, shq } from "./repo-prep";

// Slice 1: ONE shared, engine-neutral repository preparer used by OpenCode AND ACP. These
// exercise it with a fake sandbox (records every executeCommand + its env) so the script
// construction, idempotent warm reuse, branch override, token redaction, and partial-failure
// behavior are provable without a live Daytona sandbox or a real clone.

// A deterministic PAT via the standard env alias makes resolveGithubToken() return a known
// token through the no-network PAT path, so the redaction test can assert where it lands.
const SENTINEL = "ghp_TESTSENTINEL_do_not_log_0000";
let priorToken: string | undefined;
beforeAll(() => {
  priorToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = SENTINEL;
});
afterAll(() => {
  if (priorToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = priorToken;
});

interface Call {
  cmd: string;
  env: Record<string, string> | undefined;
}
function fakeSandbox(opts: { alreadyCloned?: boolean; cloneExit?: number; cloneOut?: string } = {}): {
  sandbox: Sandbox;
  calls: Call[];
} {
  const calls: Call[] = [];
  const process = {
    executeCommand: async (cmd: string, _cwd?: string, env?: Record<string, string>) => {
      calls.push({ cmd, env });
      if (/echo yes \|\| echo no/.test(cmd)) return { result: opts.alreadyCloned ? "yes" : "no", exitCode: 0 };
      if (/git clone/.test(cmd)) return { result: opts.cloneOut ?? "clone:ok", exitCode: opts.cloneExit ?? 0 };
      return { result: "", exitCode: 0 };
    },
  };
  return { sandbox: { process } as unknown as Sandbox, calls };
}
function fakeCtx(repos?: string[]): { ctx: EngineRunContext; emits: { label?: string }[] } {
  const emits: { label?: string }[] = [];
  const ctx = {
    emit: async (s: { label?: string }) => {
      emits.push(s);
      return "step-id";
    },
    signal: new AbortController().signal,
    repos,
  } as unknown as EngineRunContext;
  return { ctx, emits };
}
const cloneCmd = (calls: Call[]) => calls.find((c) => /git clone/.test(c.cmd));

describe("repo-prep: shared engine-neutral repository preparation (Slice 1)", () => {
  test("shq single-quotes and POSIX-escapes embedded quotes", () => {
    expect(shq("a b")).toBe("'a b'");
    expect(shq("it's")).toBe("'it'\\''s'"); // close, escaped-quote, reopen
  });

  test("a fresh single repo clones into its own subdir with the correct URL", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { ctx, emits } = fakeCtx();
    await ensureRepoClone(sandbox, "/home/daytona/work", "acme/widget", ctx);
    const clone = cloneCmd(calls);
    expect(clone).toBeDefined();
    expect(clone!.cmd).toContain("git clone");
    expect(clone!.cmd).toContain("'https://github.com/acme/widget.git'");
    expect(clone!.cmd).toContain("/home/daytona/work/widget");
    expect(emits.some((e) => e.label === "Cloning acme/widget")).toBe(true);
  });

  test("a branch override clones with -b <branch> and labels it", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { ctx, emits } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/widget:dev", ctx);
    const clone = cloneCmd(calls);
    expect(clone).toBeDefined();
    expect(clone?.cmd).toContain("-b 'dev'");
    expect(clone?.cmd).toContain("'https://github.com/acme/widget.git'");
    expect(emits.some((e) => e.label === "Cloning acme/widget (dev)")).toBe(true);
  });

  test("prepareRepos clones EVERY selected repo (multi-repo workspace)", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { ctx } = fakeCtx(["a/x", "b/y", "c/z"]);
    await prepareRepos(sandbox, "/w", ctx);
    const clones = calls.filter((c) => /git clone/.test(c.cmd));
    expect(clones).toHaveLength(3);
    expect(clones[0]?.cmd).toContain("'https://github.com/a/x.git'");
    expect(clones[2]?.cmd).toContain("'https://github.com/c/z.git'");
  });

  test("idempotent warm reuse: an already-cloned repo is a fast skip (no clone, no Cloning step)", async () => {
    const { sandbox, calls } = fakeSandbox({ alreadyCloned: true });
    const { ctx, emits } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/widget", ctx);
    expect(cloneCmd(calls)).toBeUndefined(); // only the cheap pre-check ran
    expect(emits.some((e) => e.label?.startsWith("Cloning"))).toBe(false);
  });

  test("token redaction: the PAT rides in ENV only, NEVER in the command string", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { ctx } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/private", ctx);
    const clone = cloneCmd(calls)!;
    // The credential is applied one-shot via GIT_CONFIG_* env (base64 x-access-token:<token>)...
    const expectedHeader = Buffer.from(`x-access-token:${SENTINEL}`).toString("base64");
    expect(clone.env?.GIT_CONFIG_VALUE_0).toContain(expectedHeader);
    // ...and NEVER appears in the shell command string, our source, or logs.
    expect(clone.cmd).not.toContain(SENTINEL);
    expect(clone.cmd).not.toContain("Authorization");
    expect(clone.cmd).not.toContain("x-access-token");
  });

  test("partial failure: a failed clone throws a SANITIZED error (git tail only, no marker, no token)", async () => {
    const { sandbox } = fakeSandbox({ cloneExit: 1, cloneOut: "clone:failed\nfatal: repository not found" });
    const { ctx } = fakeCtx();
    let msg = "";
    await ensureRepoClone(sandbox, "/w", "acme/ghost", ctx).catch((e) => {
      msg = e instanceof Error ? e.message : String(e);
    });
    expect(msg).toContain("failed to clone acme/ghost");
    expect(msg).toContain("fatal: repository not found");
    expect(msg).not.toContain("clone:failed"); // the internal marker is stripped
    expect(msg).not.toContain(SENTINEL);
  });

  test("no repos selected is a no-op (bare thread)", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { ctx } = fakeCtx(undefined);
    await prepareRepos(sandbox, "/w", ctx);
    expect(calls).toHaveLength(0);
  });
});
