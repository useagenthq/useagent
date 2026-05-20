import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import type { EngineRunContext } from "./types";
import { ensureRepoClone, prepareRepos, shq } from "./repo-prep";
import { RUN_TIMING_OUTCOMES, RUN_TIMING_STAGES, type TimingSpanEnd } from "../runs/run-timing";

// Slice 1 + Phase 5 (non-destructive hardening): ONE shared, engine-neutral repository preparer.
// Exercised with a fake sandbox (records every executeCommand + env) so script construction,
// OWNER-QUALIFIED checkout dirs, the ownership-marker state machine (reuse / branch / owned-stale
// / foreign / occupied / absent), clone-into-temp + atomic rename, fail-closed on unowned content,
// token redaction, and partial failure are provable without a live sandbox.

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
/** `state` is what the pre-check reports for the destination: "reuse" (right repo+branch),
 *  "branch" (right repo, wrong branch -> switch in place), "owned-stale" (a Skynet-owned checkout
 *  of a different repo -> safe to replace), "foreign" (an UNOWNED git repo, different origin ->
 *  fail closed), "occupied" (UNOWNED non-git content -> fail closed), "absent" (nothing there). */
function fakeSandbox(opts: { state?: "reuse" | "branch" | "owned-stale" | "foreign" | "occupied" | "absent"; cloneExit?: number; cloneOut?: string; switchExit?: number; switchOut?: string } = {}): {
  sandbox: SandboxHandle;
  calls: Call[];
} {
  const calls: Call[] = [];
  const process = {
    executeCommand: async (cmd: string, _cwd?: string, env?: Record<string, string>) => {
      calls.push({ cmd, env });
      if (/echo state:absent/.test(cmd) && !/git clone/.test(cmd)) return { result: `state:${opts.state ?? "absent"}`, exitCode: 0 };
      if (/git -C .* (fetch|checkout)/.test(cmd)) return { result: opts.switchOut ?? "switch:ok", exitCode: opts.switchExit ?? 0 };
      if (/git clone/.test(cmd)) return { result: opts.cloneOut ?? "clone:ok", exitCode: opts.cloneExit ?? 0 };
      return { result: "", exitCode: 0 };
    },
  };
  return { sandbox: { process } as unknown as SandboxHandle, calls };
}
function fakeCtx(repos?: string[]): {
  ctx: EngineRunContext;
  emits: { label?: string }[];
  timing: { stage: string; outcome?: string }[];
} {
  const emits: { label?: string }[] = [];
  const timing: { stage: string; outcome?: string }[] = [];
  const ctx = {
    emit: async (s: { label?: string }) => { emits.push(s); return "step-id"; },
    signal: new AbortController().signal,
    repos,
    timing: {
      begin: (stage: string): TimingSpanEnd => (outcome) => {
        timing.push({ stage, outcome });
      },
      mark: () => {},
    },
  } as unknown as EngineRunContext;
  return { ctx, emits, timing };
}
const cloneCmd = (calls: Call[]) => calls.find((c) => /git clone/.test(c.cmd));
const idCmd = (calls: Call[]) => calls.find((c) => /echo state:absent/.test(c.cmd) && !/git clone/.test(c.cmd));
const switchCmd = (calls: Call[]) => calls.find((c) => /git -C .* checkout/.test(c.cmd));

describe("repo-prep: shared engine-neutral repository preparation", () => {
  test("shq single-quotes and POSIX-escapes embedded quotes", () => {
    expect(shq("a b")).toBe("'a b'");
    expect(shq("it's")).toBe("'it'\\''s'");
  });

  test("a fresh single repo clones into an OWNER-QUALIFIED subdir via a temp dir + atomic rename", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx, emits } = fakeCtx();
    await ensureRepoClone(sandbox, "/home/daytona/work", "acme/widget", ctx);
    const clone = cloneCmd(calls);
    expect(clone).toBeDefined();
    expect(clone?.cmd).toContain("git clone");
    expect(clone?.cmd).toContain("'https://github.com/acme/widget.git'");
    expect(clone?.cmd).toContain("/home/daytona/work/acme/widget"); // <owner>/<name>, not bare <name>
    expect(clone?.cmd).toContain("mktemp -d"); // clone into a unique temp sibling first
    expect(clone?.cmd).toContain('mv -T "$TMP" "$DIR"'); // then atomically rename into place (mv -T = no nest)
    expect(clone?.cmd).toContain('mv "$DIR" "$BAK"'); // owned/absent replace moves the old aside atomically first
    expect(clone?.cmd).not.toContain('rm -rf "$DIR"'); // never rm the destination (race-safe move-aside instead)
    expect(clone?.cmd).toContain("ALLOW=no"); // absent destination -> never replace
    expect(clone?.cmd).toContain("skynet-owned"); // stamps the ownership marker
    expect(emits.some((e) => e.label === "Cloning acme/widget")).toBe(true);
  });

  test("a public gateway clone never injects the organization GitHub credential", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx } = fakeCtx();
    await ensureRepoClone(
      sandbox,
      "/root/work",
      "octocat/Hello-World",
      ctx,
      { useGithubCredential: false },
    );
    expect(cloneCmd(calls)?.env).toEqual({});
  });

  test("a branch override clones with -b <branch>, and the identity check requires that branch", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx, emits } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/widget:dev", ctx);
    expect(cloneCmd(calls)?.cmd).toContain("-b 'dev'");
    expect(idCmd(calls)?.cmd).toContain("'dev'"); // branch is part of the reuse identity
    expect(emits.some((e) => e.label === "Cloning acme/widget (dev)")).toBe(true);
  });

  test("prepareRepos clones EVERY selected repo (multi-repo workspace)", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx } = fakeCtx(["a/x", "b/y", "c/z"]);
    await prepareRepos(sandbox, "/w", ctx);
    const clones = calls.filter((c) => /git clone/.test(c.cmd));
    expect(clones).toHaveLength(3);
    expect(clones[0]?.cmd).toContain("/w/a/x");
    expect(clones[2]?.cmd).toContain("/w/c/z");
  });

  test("SAME-BASENAME repos from different owners get DISTINCT checkouts (no collision)", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx } = fakeCtx(["orgA/widget", "orgB/widget"]);
    await prepareRepos(sandbox, "/w", ctx);
    const clones = calls.filter((c) => /git clone/.test(c.cmd));
    expect(clones).toHaveLength(2);
    expect(clones[0]?.cmd).toContain("/w/orgA/widget");
    expect(clones[1]?.cmd).toContain("/w/orgB/widget");
    expect(clones[0]?.cmd).not.toContain("/w/orgB/widget");
  });

  test("REUSE: a checkout with matching origin+branch is a fast skip (no clone, no step)", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "reuse" });
    const { ctx, emits } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/widget", ctx);
    expect(cloneCmd(calls)).toBeUndefined();
    expect(emits.some((e) => e.label?.startsWith("Cloning"))).toBe(false);
  });

  test("SAME repo, WRONG branch: switch IN PLACE (fetch+checkout), NEVER rm -rf a warm checkout", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "branch" });
    const { ctx, emits } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/widget:main", ctx);
    const sw = switchCmd(calls);
    expect(sw).toBeDefined();
    expect(sw?.cmd).toContain("git -C \"$DIR\" fetch origin 'main'");
    expect(sw?.cmd).toContain("git -C \"$DIR\" checkout 'main'");
    expect(sw?.cmd).not.toContain("rm -rf");
    expect(cloneCmd(calls)).toBeUndefined();
    expect(emits.some((e) => e.label === "Checking out acme/widget (main)")).toBe(true);
    expect(sw?.env?.GIT_CONFIG_VALUE_0).toContain(Buffer.from(`x-access-token:${SENTINEL}`).toString("base64"));
    expect(sw?.cmd).not.toContain(SENTINEL);
  });

  test("a branch switch that FAILS throws a SANITIZED error and does not fall through to a re-clone", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "branch", switchExit: 1, switchOut: "switch:failed\nerror: pathspec 'main' did not match" });
    const { ctx } = fakeCtx();
    let msg = "";
    await ensureRepoClone(sandbox, "/w", "acme/widget:main", ctx).catch((e) => { msg = e instanceof Error ? e.message : String(e); });
    expect(msg).toContain("failed to switch acme/widget to main");
    expect(msg).toContain("error: pathspec 'main' did not match");
    expect(msg).not.toContain("switch:failed");
    expect(msg).not.toContain(SENTINEL);
    expect(cloneCmd(calls)).toBeUndefined();
  });

  test("FOREIGN: an UNOWNED git repo with a different origin FAILS CLOSED (never rm, never clone)", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "foreign" });
    const { ctx } = fakeCtx();
    let msg = "";
    await ensureRepoClone(sandbox, "/w", "acme/widget:main", ctx).catch((e) => { msg = e instanceof Error ? e.message : String(e); });
    expect(msg).toContain("refusing to prepare acme/widget");
    expect(msg).toContain("different git repository not created by Skynet");
    expect(cloneCmd(calls)).toBeUndefined();
    expect(switchCmd(calls)).toBeUndefined();
  });

  test("OCCUPIED: UNOWNED non-git content at the destination FAILS CLOSED (never rm, never clone)", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "occupied" });
    const { ctx } = fakeCtx();
    let msg = "";
    await ensureRepoClone(sandbox, "/w", "acme/widget", ctx).catch((e) => { msg = e instanceof Error ? e.message : String(e); });
    expect(msg).toContain("refusing to prepare acme/widget");
    expect(msg).toContain("content not created by Skynet");
    expect(cloneCmd(calls)).toBeUndefined();
  });

  test("OWNED-STALE: a Skynet-owned checkout of a different repo is safe to REPLACE (ALLOW=yes)", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "owned-stale" });
    const { ctx } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/widget:main", ctx);
    const clone = cloneCmd(calls);
    expect(clone).toBeDefined();
    expect(clone?.cmd).toContain("ALLOW=yes"); // we own it -> may replace
    expect(clone?.cmd).toContain("mktemp -d"); // still via temp + rename (clone succeeds before replacing)
    expect(clone?.cmd).toContain("-b 'main'");
  });

  test("token redaction: the PAT rides in ENV only, NEVER in the command string", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/private", ctx);
    const clone = cloneCmd(calls);
    const expectedHeader = Buffer.from(`x-access-token:${SENTINEL}`).toString("base64");
    expect(clone?.env?.GIT_CONFIG_VALUE_0).toContain(expectedHeader);
    expect(clone?.cmd).not.toContain(SENTINEL);
    expect(clone?.cmd).not.toContain("Authorization");
    expect(clone?.cmd).not.toContain("x-access-token");
  });

  test("partial/interrupted clone: a failed clone throws a SANITIZED error (git tail only, no marker, no token)", async () => {
    const { sandbox } = fakeSandbox({ state: "absent", cloneExit: 1, cloneOut: "clone:failed\nfatal: repository not found" });
    const { ctx } = fakeCtx();
    let msg = "";
    await ensureRepoClone(sandbox, "/w", "acme/ghost", ctx).catch((e) => { msg = e instanceof Error ? e.message : String(e); });
    expect(msg).toContain("failed to clone acme/ghost");
    expect(msg).toContain("fatal: repository not found");
    expect(msg).not.toContain("clone:failed");
    expect(msg).not.toContain(SENTINEL);
  });

  test("a destination that turns UNOWNED during preparation (clone:collision) fails closed", async () => {
    const { sandbox } = fakeSandbox({ state: "absent", cloneExit: 1, cloneOut: "clone:collision" });
    const { ctx } = fakeCtx();
    let msg = "";
    await ensureRepoClone(sandbox, "/w", "acme/widget", ctx).catch((e) => { msg = e instanceof Error ? e.message : String(e); });
    expect(msg).toContain("occupied by unowned content during preparation");
  });

  test("no repos selected is a no-op (bare thread)", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { ctx, timing } = fakeCtx(undefined);
    await prepareRepos(sandbox, "/w", ctx);
    expect(calls).toHaveLength(0);
    expect(timing).toEqual([
      { stage: RUN_TIMING_STAGES.repoPrep, outcome: RUN_TIMING_OUTCOMES.skipped },
    ]);
  });

  test("prepareRepos records one low-cardinality success outcome across selected repos", async () => {
    const { sandbox } = fakeSandbox({ state: "absent" });
    const { ctx, timing } = fakeCtx(["acme/one", "acme/two"]);

    await prepareRepos(sandbox, "/w", ctx);

    expect(timing).toEqual([
      { stage: RUN_TIMING_STAGES.repoPrep, outcome: RUN_TIMING_OUTCOMES.success },
    ]);
  });
});
