import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Sandbox } from "@daytona/sdk";
import type { EngineRunContext } from "./types";
import { ensureRepoClone, prepareRepos, shq } from "./repo-prep";

// Slice 1 (+ review hardening): ONE shared, engine-neutral repository preparer. Exercised with
// a fake sandbox (records every executeCommand + env) so script construction, OWNER-QUALIFIED
// checkout dirs, identity reuse (origin + branch), same-basename/wrong-origin/wrong-branch
// collision handling, token redaction, and partial failure are provable without a live sandbox.

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
/** `identity` is what the pre-check reports for an EXISTING dir: "reuse" (same origin+branch),
 *  "branch" (SAME origin, wrong branch -> switch in place, non-destructive), "origin" (DIFFERENT
 *  origin, a genuine collision -> re-clone), or "absent" (fresh - nothing there yet). */
function fakeSandbox(opts: { identity?: "reuse" | "branch" | "origin" | "absent"; cloneExit?: number; cloneOut?: string; switchExit?: number; switchOut?: string } = {}): {
  sandbox: Sandbox;
  calls: Call[];
} {
  const calls: Call[] = [];
  const process = {
    executeCommand: async (cmd: string, _cwd?: string, env?: Record<string, string>) => {
      calls.push({ cmd, env });
      if (/remote get-url origin/.test(cmd)) return { result: `id:${opts.identity ?? "absent"}`, exitCode: 0 };
      if (/git -C .* (fetch|checkout)/.test(cmd)) return { result: opts.switchOut ?? "switch:ok", exitCode: opts.switchExit ?? 0 };
      if (/git clone/.test(cmd)) return { result: opts.cloneOut ?? "clone:ok", exitCode: opts.cloneExit ?? 0 };
      return { result: "", exitCode: 0 };
    },
  };
  return { sandbox: { process } as unknown as Sandbox, calls };
}
function fakeCtx(repos?: string[]): { ctx: EngineRunContext; emits: { label?: string }[] } {
  const emits: { label?: string }[] = [];
  const ctx = {
    emit: async (s: { label?: string }) => { emits.push(s); return "step-id"; },
    signal: new AbortController().signal,
    repos,
  } as unknown as EngineRunContext;
  return { ctx, emits };
}
const cloneCmd = (calls: Call[]) => calls.find((c) => /git clone/.test(c.cmd));
const idCmd = (calls: Call[]) => calls.find((c) => /remote get-url origin/.test(c.cmd));
const switchCmd = (calls: Call[]) => calls.find((c) => /git -C .* checkout/.test(c.cmd));

describe("repo-prep: shared engine-neutral repository preparation (Slice 1)", () => {
  test("shq single-quotes and POSIX-escapes embedded quotes", () => {
    expect(shq("a b")).toBe("'a b'");
    expect(shq("it's")).toBe("'it'\\''s'");
  });

  test("a fresh single repo clones into an OWNER-QUALIFIED subdir with the correct URL", async () => {
    const { sandbox, calls } = fakeSandbox({ identity: "absent" });
    const { ctx, emits } = fakeCtx();
    await ensureRepoClone(sandbox, "/home/daytona/work", "acme/widget", ctx);
    const clone = cloneCmd(calls);
    expect(clone).toBeDefined();
    expect(clone?.cmd).toContain("git clone");
    expect(clone?.cmd).toContain("'https://github.com/acme/widget.git'");
    expect(clone?.cmd).toContain("/home/daytona/work/acme/widget"); // <owner>/<name>, not bare <name>
    expect(emits.some((e) => e.label === "Cloning acme/widget")).toBe(true);
  });

  test("a branch override clones with -b <branch>, and the identity check requires that branch", async () => {
    const { sandbox, calls } = fakeSandbox({ identity: "absent" });
    const { ctx, emits } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/widget:dev", ctx);
    expect(cloneCmd(calls)?.cmd).toContain("-b 'dev'");
    expect(idCmd(calls)?.cmd).toContain("'dev'"); // branch is part of the reuse identity
    expect(emits.some((e) => e.label === "Cloning acme/widget (dev)")).toBe(true);
  });

  test("prepareRepos clones EVERY selected repo (multi-repo workspace)", async () => {
    const { sandbox, calls } = fakeSandbox({ identity: "absent" });
    const { ctx } = fakeCtx(["a/x", "b/y", "c/z"]);
    await prepareRepos(sandbox, "/w", ctx);
    const clones = calls.filter((c) => /git clone/.test(c.cmd));
    expect(clones).toHaveLength(3);
    expect(clones[0]?.cmd).toContain("/w/a/x");
    expect(clones[2]?.cmd).toContain("/w/c/z");
  });

  test("SAME-BASENAME repos from different owners get DISTINCT checkouts (no collision)", async () => {
    const { sandbox, calls } = fakeSandbox({ identity: "absent" });
    const { ctx } = fakeCtx(["orgA/widget", "orgB/widget"]);
    await prepareRepos(sandbox, "/w", ctx);
    const clones = calls.filter((c) => /git clone/.test(c.cmd));
    expect(clones).toHaveLength(2);
    expect(clones[0]?.cmd).toContain("/w/orgA/widget");
    expect(clones[1]?.cmd).toContain("/w/orgB/widget");
    expect(clones[0]?.cmd).not.toContain("/w/orgB/widget");
  });

  test("IDENTITY reuse: a checkout with matching origin+branch is a fast skip (no clone, no step)", async () => {
    const { sandbox, calls } = fakeSandbox({ identity: "reuse" });
    const { ctx, emits } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/widget", ctx);
    expect(cloneCmd(calls)).toBeUndefined();
    expect(emits.some((e) => e.label?.startsWith("Cloning"))).toBe(false);
  });

  test("SAME origin, WRONG branch: switch IN PLACE (fetch+checkout), NEVER rm -rf a warm checkout", async () => {
    const { sandbox, calls } = fakeSandbox({ identity: "branch" });
    const { ctx, emits } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/widget:main", ctx);
    // The requested repo IS already there (same origin) - preserve its working tree: fetch +
    // checkout the branch, no clone, no rm -rf. A warm checkout's local work survives.
    const sw = switchCmd(calls);
    expect(sw).toBeDefined();
    expect(sw?.cmd).toContain("git -C \"$DIR\" fetch origin 'main'");
    expect(sw?.cmd).toContain("git -C \"$DIR\" checkout 'main'");
    expect(sw?.cmd).not.toContain("rm -rf");
    expect(cloneCmd(calls)).toBeUndefined();
    expect(emits.some((e) => e.label === "Checking out acme/widget (main)")).toBe(true);
    // the one-shot GitHub credential rides in ENV on the fetch, never the command string
    expect(sw?.env?.GIT_CONFIG_VALUE_0).toContain(Buffer.from(`x-access-token:${SENTINEL}`).toString("base64"));
    expect(sw?.cmd).not.toContain(SENTINEL);
  });

  test("a branch switch that FAILS throws a SANITIZED error (no marker, no token) and does not rm", async () => {
    const { sandbox, calls } = fakeSandbox({ identity: "branch", switchExit: 1, switchOut: "switch:failed\nerror: pathspec 'main' did not match" });
    const { ctx } = fakeCtx();
    let msg = "";
    await ensureRepoClone(sandbox, "/w", "acme/widget:main", ctx).catch((e) => { msg = e instanceof Error ? e.message : String(e); });
    expect(msg).toContain("failed to switch acme/widget to main");
    expect(msg).toContain("error: pathspec 'main' did not match");
    expect(msg).not.toContain("switch:failed");
    expect(msg).not.toContain(SENTINEL);
    expect(cloneCmd(calls)).toBeUndefined(); // a failed switch does NOT fall through to a destructive re-clone
  });

  test("DIFFERENT origin (genuine collision): the stale dir is RE-CLONED (rm -rf + git clone)", async () => {
    const { sandbox, calls } = fakeSandbox({ identity: "origin" });
    const { ctx } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/widget:main", ctx);
    // A dir holding a DIFFERENT repo at this owner/name path is not the user's warm work for THIS
    // repo - clear it and clone fresh.
    expect(idCmd(calls)).toBeDefined();
    expect(switchCmd(calls)).toBeUndefined();
    const clone = cloneCmd(calls);
    expect(clone).toBeDefined();
    expect(clone?.cmd).toContain('rm -rf "$DIR"');
    expect(clone?.cmd).toContain("-b 'main'");
  });

  test("token redaction: the PAT rides in ENV only, NEVER in the command string", async () => {
    const { sandbox, calls } = fakeSandbox({ identity: "absent" });
    const { ctx } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/private", ctx);
    const clone = cloneCmd(calls);
    const expectedHeader = Buffer.from(`x-access-token:${SENTINEL}`).toString("base64");
    expect(clone?.env?.GIT_CONFIG_VALUE_0).toContain(expectedHeader);
    expect(clone?.cmd).not.toContain(SENTINEL);
    expect(clone?.cmd).not.toContain("Authorization");
    expect(clone?.cmd).not.toContain("x-access-token");
  });

  test("partial failure: a failed clone throws a SANITIZED error (git tail only, no marker, no token)", async () => {
    const { sandbox } = fakeSandbox({ identity: "absent", cloneExit: 1, cloneOut: "clone:failed\nfatal: repository not found" });
    const { ctx } = fakeCtx();
    let msg = "";
    await ensureRepoClone(sandbox, "/w", "acme/ghost", ctx).catch((e) => { msg = e instanceof Error ? e.message : String(e); });
    expect(msg).toContain("failed to clone acme/ghost");
    expect(msg).toContain("fatal: repository not found");
    expect(msg).not.toContain("clone:failed");
    expect(msg).not.toContain(SENTINEL);
  });

  test("no repos selected is a no-op (bare thread)", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { ctx } = fakeCtx(undefined);
    await prepareRepos(sandbox, "/w", ctx);
    expect(calls).toHaveLength(0);
  });
});
