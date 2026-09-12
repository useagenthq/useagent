import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { composeBoxCommand } from "@useagent/sandbox-box";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import type { RunResource } from "../resources/types";
import type { EngineRunContext } from "./types";
import {
  checkoutPullRequestResources,
  ensureRepoClone,
  prepareRepos,
  shq,
} from "./repo-prep";
import { RUN_TIMING_OUTCOMES, RUN_TIMING_STAGES, type TimingSpanEnd } from "../runs/run-timing";

// Slice 1 + Phase 5 (non-destructive hardening): ONE shared, engine-neutral repository preparer.
// Exercised with a fake sandbox (records every executeCommand + env) so script construction,
// OWNER-QUALIFIED checkout dirs, the ownership-marker state machine (reuse / branch / owned-stale
// / foreign / occupied / absent), root-owned clone staging + atomic rename, fail-closed on unowned content,
// token redaction, and partial failure are provable without a live sandbox.

const SENTINEL = "ghp_TESTSENTINEL_do_not_log_0000";
const BOX_LAYOUT: SandboxRuntimeLayout = {
  home: "/home/user",
  workdir: "/home/user/work",
  runsAsRoot: false,
  bunExecutable: "/usr/local/bin/bun",
};
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
interface FakeSandboxOptions {
  state?: "reuse" | "ownership" | "branch" | "agent-branch" | "owned-stale" | "foreign" | "occupied" | "empty" | "absent";
  cloneExit?: number;
  cloneOut?: string;
  switchExit?: number;
  switchOut?: string;
  pullExit?: number;
  pullOut?: string;
}
/** `state` is what the pre-check reports for the destination: "reuse" (right repo+branch),
 *  "branch" (right repo, wrong branch -> require a fresh workspace), "owned-stale" (a useAgent-owned checkout
 *  of a different repo -> safe to replace), "foreign" (an UNOWNED git repo, different origin ->
 *  fail closed), "occupied" (UNOWNED non-git content -> fail closed), "absent" (nothing there). */
function fakeSandbox(opts: FakeSandboxOptions = {}): {
  sandbox: SandboxHandle;
  calls: Call[];
} {
  const calls: Call[] = [];
  const process = {
    executeCommand: async (cmd: string, _cwd?: string, env?: Record<string, string>) => {
      calls.push({ cmd, env });
      if (/echo state:absent/.test(cmd) && !/git clone/.test(cmd)) return { result: `state:${opts.state ?? "absent"}`, exitCode: 0 };
      if (/refs\/pull\//.test(cmd)) return { result: opts.pullOut ?? "pr:ok", exitCode: opts.pullExit ?? 0 };
      if (/git .* -C .* (fetch|checkout)/.test(cmd)) return { result: opts.switchOut ?? "switch:ok", exitCode: opts.switchExit ?? 0 };
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
    orgId: "org-acme",
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
const switchCmd = (calls: Call[]) => calls.find((c) => /git .* -C .* checkout/.test(c.cmd));
const pullCmd = (calls: Call[]) => calls.find((c) => /refs\/pull\//.test(c.cmd));

async function withProductionMode<T>(action: () => Promise<T>): Promise<T> {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorDevMode = process.env.USEAGENT_DEV_MODE;
  const priorTenantOrgId = process.env.GITHUB_TENANT_ORG_ID;
  process.env.NODE_ENV = "production";
  process.env.USEAGENT_DEV_MODE = "false";
  process.env.GITHUB_TENANT_ORG_ID = "org-acme";
  try {
    return await action();
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (priorDevMode === undefined) delete process.env.USEAGENT_DEV_MODE;
    else process.env.USEAGENT_DEV_MODE = priorDevMode;
    if (priorTenantOrgId === undefined) delete process.env.GITHUB_TENANT_ORG_ID;
    else process.env.GITHUB_TENANT_ORG_ID = priorTenantOrgId;
  }
}

const pullRequestResource = (
  revision: string | null,
): RunResource => ({
  kind: "code.change",
  provider: "github",
  locator: {
    type: "github.pull_request",
    repository: "acme/widget",
    number: 42,
    revision,
  },
  capabilities: ["change.read"],
  provenance: [
    {
      source: "user_text",
      channel: "web",
      raw: "https://github.com/acme/widget/pull/42",
      start: 0,
      end: 40,
    },
  ],
});

describe("repo-prep: shared engine-neutral repository preparation", () => {
  test("shq single-quotes and POSIX-escapes embedded quotes", () => {
    expect(shq("a b")).toBe("'a b'");
    expect(shq("it's")).toBe("'it'\\''s'");
  });

  test("a fresh single repo clones from root-owned staging into an OWNER-QUALIFIED subdir", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx, emits } = fakeCtx();
    const changed = await ensureRepoClone(sandbox, "/home/daytona/work", "acme/widget", ctx);
    expect(changed).toBe(true);
    const clone = cloneCmd(calls);
    expect(clone).toBeDefined();
    expect(clone?.cmd).toContain("git clone");
    expect(clone?.cmd).toContain("'https://github.com/acme/widget.git'");
    expect(clone?.cmd).toContain("/home/daytona/work/acme/widget"); // <owner>/<name>, not bare <name>
    expect(clone?.cmd).toContain("STAGE_ROOT='/root/.skynet/repo-staging'");
    expect(clone?.cmd).toContain('mktemp -d "$STAGE_ROOT/clone.XXXXXX"');
    expect(clone?.cmd).not.toContain('mktemp -d "$PARENT/');
    expect(clone?.cmd).toContain('stat -c %u "$PARENT"');
    expect(clone?.cmd).toContain("clone:parent-untrusted");
    expect(clone?.cmd).toContain('mv -T "$TMP" "$DIR"'); // then atomically rename into place (mv -T = no nest)
    expect(clone?.cmd).toContain('mv "$DIR" "$BAK"'); // owned/absent replace moves the old aside atomically first
    expect(clone?.cmd).not.toContain('rm -rf "$DIR"'); // never rm the destination (race-safe move-aside instead)
    expect(clone?.cmd).toContain("ALLOW=no"); // absent destination -> never replace
    expect(clone?.cmd).toContain("skynet-owned"); // stamps the ownership marker
    expect(emits.some((e) => e.label === "Cloning acme/widget")).toBe(true);
  });

  test("a fresh non-root repo uses the declared runtime workspace, staging, and ownership receipt", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx } = fakeCtx();

    await ensureRepoClone(sandbox, BOX_LAYOUT.workdir, "acme/widget", ctx, {
      runtimeLayout: BOX_LAYOUT,
    });

    const identity = idCmd(calls)?.cmd ?? "";
    const clone = cloneCmd(calls)?.cmd ?? "";
    expect(identity).toContain('CURRENT_UID="$(id -u)"');
    expect(identity).toContain('if [ "$O" = "$CURRENT_UID" ]');
    expect(identity).toContain("'/home/user/.skynet/repo-runtime-ownership/");
    expect(clone).toContain("DIR='/home/user/work/acme/widget'");
    expect(clone).toContain("STAGE_ROOT='/home/user/.skynet/repo-staging'");
    expect(clone).toContain("OWNERSHIP_ROOT='/home/user/.skynet/repo-runtime-ownership'");
    expect(clone).toContain('"$(stat -c %u "$PARENT" 2>/dev/null)" != "$CURRENT_UID"');
    expect(clone).toContain('printf \'uid=%s\n\' "$CURRENT_UID"');
    expect(`${identity}\n${clone}`).not.toContain("/root");
    expect(`${identity}\n${clone}`).not.toContain('"$O" = 1000');
    expect(`${identity}\n${clone}`).not.toContain('"$O" = 0');
    expect(clone).not.toContain("-o 0");
    expect(clone).not.toContain('|| [ -f "$DIR/.git/skynet-owned" ]');
    expect(clone).toContain("Clone succeeded, but checkout failed.");
    expect(clone).toContain('git --git-dir="$TMP/.git" config core.bare false');
    expect(clone).toContain('git --git-dir="$TMP/.git" --work-tree="$TMP" checkout --force HEAD');
    expect(cloneCmd(calls)?.env).toEqual({});
    expect(composeBoxCommand(clone, undefined, cloneCmd(calls)?.env)).not.toContain(SENTINEL);
  });

  test("a user-owned empty runtime placeholder is replaced only after rmdir proves it stayed empty", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "empty" });
    const { ctx } = fakeCtx();

    expect(await ensureRepoClone(sandbox, BOX_LAYOUT.workdir, "acme/widget", ctx, {
      runtimeLayout: BOX_LAYOUT,
    })).toBe(true);

    const identity = idCmd(calls)?.cmd ?? "";
    const clone = cloneCmd(calls)?.cmd ?? "";
    expect(identity).toContain("state:empty");
    expect(identity).toContain('"$(stat -c %u "$DIR" 2>/dev/null)" = "$(id -u)"');
    expect(identity).toContain('find "$DIR" -mindepth 1 -maxdepth 1 -print -quit');
    expect(clone).toContain("ALLOW=empty");
    expect(clone).toContain('rmdir "$DIR"');
    expect(clone).not.toContain('rm -rf "$DIR"');
  });

  test.skipIf(process.platform !== "linux")(
    "the generated clone shell replaces an empty placeholder but preserves content appearing before placement",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "useagent-repo-shell-"));
      const source = join(root, "source");
      const runtimeLayout: SandboxRuntimeLayout = {
        home: join(root, "home"),
        workdir: join(root, "unused"),
        runsAsRoot: false,
      };
      const runGit = (args: string[]) => Bun.spawnSync(["git", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const shellSandbox = (injectRace: boolean): SandboxHandle => ({
        process: {
          async executeCommand(command: string, _cwd?: string, env?: Record<string, string>) {
            const localCommand = command.includes("git clone")
              ? command
                  .replaceAll(shq("https://github.com/acme/widget.git"), shq(source))
                  .replace(
                    'if [ -e "$DIR" ]; then ',
                    `${injectRace ? 'printf protected > "$DIR/appeared.txt"; ' : ""}if [ -e "$DIR" ]; then `,
                  )
              : command;
            const result = Bun.spawnSync(["/bin/sh", "-c", localCommand], {
              env: { ...process.env, ...env },
              stdout: "pipe",
              stderr: "pipe",
            });
            return {
              exitCode: result.exitCode,
              result: `${result.stdout.toString()}${result.stderr.toString()}`,
            };
          },
        },
      }) as unknown as SandboxHandle;
      try {
        await mkdir(source);
        expect(runGit(["-C", source, "init", "-q", "--initial-branch=main"]).exitCode).toBe(0);
        await writeFile(join(source, "tracked.txt"), "real generated-shell checkout\n");
        expect(runGit(["-C", source, "add", "tracked.txt"]).exitCode).toBe(0);
        expect(runGit([
          "-C", source,
          "-c", "user.name=useAgent test",
          "-c", "user.email=test@useagent.dev",
          "commit", "-qm", "fixture",
        ]).exitCode).toBe(0);

        const successWorkdir = join(root, "success", "work");
        const successDir = join(successWorkdir, "acme", "widget");
        await mkdir(successDir, { recursive: true });
        expect(await ensureRepoClone(shellSandbox(false), successWorkdir, "acme/widget", fakeCtx().ctx, {
          runtimeLayout,
        })).toBe(true);
        expect(await readFile(join(successDir, "tracked.txt"), "utf8"))
          .toBe("real generated-shell checkout\n");

        const racedWorkdir = join(root, "raced", "work");
        const racedDir = join(racedWorkdir, "acme", "widget");
        await mkdir(racedDir, { recursive: true });
        await expect(ensureRepoClone(shellSandbox(true), racedWorkdir, "acme/widget", fakeCtx().ctx, {
          runtimeLayout,
        })).rejects.toThrow("occupied by unowned content during preparation");
        expect(await readFile(join(racedDir, "appeared.txt"), "utf8")).toBe("protected");
      } finally {
        await chmod(root, 0o700).catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("the checkout recovery repairs a real clone that Git currently treats as bare", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-repo-prep-"));
    const source = join(root, "source");
    const checkout = join(root, "checkout");
    const runGit = (args: string[]) => Bun.spawnSync(["git", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await mkdir(source);
      expect(runGit(["-C", source, "init", "-q", "--initial-branch=main"]).exitCode).toBe(0);
      await writeFile(join(source, "tracked.txt"), "real checkout\n");
      expect(runGit(["-C", source, "add", "tracked.txt"]).exitCode).toBe(0);
      expect(runGit([
        "-C", source,
        "-c", "user.name=useAgent test",
        "-c", "user.email=test@useagent.dev",
        "commit", "-qm", "fixture",
      ]).exitCode).toBe(0);
      expect(runGit(["clone", "--no-checkout", source, checkout]).exitCode).toBe(0);
      expect(runGit(["-C", checkout, "config", "core.bare", "true"]).exitCode).toBe(0);

      const implicit = runGit(["-C", checkout, "checkout", "--force", "HEAD"]);
      expect(implicit.exitCode).not.toBe(0);
      expect(implicit.stderr.toString()).toContain("operation must be run in a work tree");

      const gitDir = join(checkout, ".git");
      expect(runGit([`--git-dir=${gitDir}`, "config", "core.bare", "false"]).exitCode).toBe(0);
      expect(runGit([
        `--git-dir=${gitDir}`,
        `--work-tree=${checkout}`,
        "checkout",
        "--force",
        "HEAD",
      ]).exitCode).toBe(0);
      expect(await readFile(join(checkout, "tracked.txt"), "utf8")).toBe("real checkout\n");
    } finally {
      await chmod(root, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a retained non-root repo trusts only the current runtime uid and declared receipt", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "reuse" });
    const { ctx } = fakeCtx();

    expect(await ensureRepoClone(sandbox, BOX_LAYOUT.workdir, "acme/widget", ctx, {
      runtimeLayout: BOX_LAYOUT,
    })).toBe(false);

    const identity = idCmd(calls)?.cmd ?? "";
    expect(identity).toContain('CURRENT_UID="$(id -u)"');
    expect(identity).toContain('"$O" = "$CURRENT_UID"');
    expect(identity).toContain("'/home/user/.skynet/repo-runtime-ownership/");
    expect(identity).not.toContain("/root");
    expect(cloneCmd(calls)).toBeUndefined();
  });

  test("a public gateway clone never injects the organization GitHub credential", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx } = fakeCtx();
    await withProductionMode(() =>
      ensureRepoClone(
        sandbox,
        "/root/work",
        "octocat/Hello-World",
        ctx,
        { useGithubCredential: false },
      ),
    );
    expect(cloneCmd(calls)?.env).toEqual({});
  });

  test("prepared public URL resources never inject the organization GitHub credential", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx } = fakeCtx(["octocat/Hello-World"]);
    ctx.resolvedResources = [{
      kind: "code.repository",
      provider: "github",
      locator: {
        type: "github.repository",
        repository: "octocat/Hello-World",
        revision: null,
      },
      capabilities: ["content.read", "code.checkout"],
      provenance: [{
        source: "user_text",
        channel: "api",
        raw: "https://github.com/octocat/Hello-World.git",
        start: 0,
        end: 41,
      }],
    }];

    await withProductionMode(() => prepareRepos(sandbox, "/root/work", ctx));

    expect(cloneCmd(calls)?.env).toEqual({});
  });

  test("a retained production sandbox rejects PAT-only private repository preparation", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx } = fakeCtx();

    await expect(
      withProductionMode(() =>
        ensureRepoClone(sandbox, "/root/work", "acme/private", ctx)
      ),
    ).rejects.toThrow(/retained sandbox.*configure GITHUB_APP_ID/s);
    expect(cloneCmd(calls)).toBeUndefined();
  });

  test("repository preparation carries the run org and rejects a different production tenant", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx } = fakeCtx();
    ctx.orgId = "org-other";

    await expect(
      withProductionMode(() =>
        ensureRepoClone(sandbox, "/root/work", "acme/private", ctx)
      ),
    ).rejects.toThrow(/not available to this organization/);
    expect(cloneCmd(calls)).toBeUndefined();
  });

  test("a branch override clones with -b <branch>, and the identity check requires that branch", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "absent" });
    const { ctx, emits } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/widget:dev", ctx);
    expect(cloneCmd(calls)?.cmd).toContain("-b 'dev'");
    expect(idCmd(calls)?.cmd).toContain("'dev'"); // branch is part of the reuse identity
    expect(emits.some((e) => e.label === "Cloning acme/widget (dev)")).toBe(true);
  });

  test("an authorized pull request fetches the base repository PR ref into a deterministic local ref and checks out detached", async () => {
    const expectedHead = "0123456789abcdef0123456789abcdef01234567";
    const { sandbox, calls } = fakeSandbox({
      pullOut: `pr:ok sha=${expectedHead}`,
    });
    const { ctx, emits } = fakeCtx(["acme/widget"]);

    const changedPaths = await checkoutPullRequestResources(
      sandbox,
      "/home/daytona/work with spaces",
      [pullRequestResource(expectedHead)],
      ctx,
    );
    expect(changedPaths).toEqual(["/home/daytona/work with spaces/acme/widget"]);

    const checkout = pullCmd(calls);
    expect(checkout).toBeDefined();
    expect(checkout?.cmd).toContain("DIR='/home/daytona/work with spaces/acme/widget'");
    expect(checkout?.cmd).toContain(
      "git -c safe.directory=\"$DIR\" -C \"$DIR\" fetch --force --quiet origin 'refs/pull/42/head:refs/skynet/pull/42/head'",
    );
    expect(checkout?.cmd).toContain(
      "git -c safe.directory=\"$DIR\" -C \"$DIR\" checkout --detach 'refs/skynet/pull/42/head'",
    );
    expect(checkout?.cmd).toContain(`EXPECTED='${expectedHead}'`);
    expect(checkout?.cmd).not.toContain("github.com/acme/widget/pull/42");
    expect(checkout?.env?.GIT_CONFIG_VALUE_0).toContain(
      Buffer.from(`x-access-token:${SENTINEL}`).toString("base64"),
    );
    expect(checkout?.cmd).not.toContain(SENTINEL);
    expect(
      emits.some((event) => event.label === "Checking out acme/widget pull request #42"),
    ).toBe(true);
  });

  test("a non-root pull request checkout mutates only a current-uid checkout with its declared receipt", async () => {
    const expectedHead = "0123456789abcdef0123456789abcdef01234567";
    const { sandbox, calls } = fakeSandbox({
      pullOut: `pr:ok sha=${expectedHead}`,
    });
    const { ctx } = fakeCtx(["acme/widget"]);

    expect(await checkoutPullRequestResources(
      sandbox,
      BOX_LAYOUT.workdir,
      [pullRequestResource(expectedHead)],
      ctx,
      BOX_LAYOUT,
    )).toEqual(["/home/user/work/acme/widget"]);

    const command = pullCmd(calls)?.cmd ?? "";
    expect(command).toContain('CURRENT_UID="$(id -u)"');
    expect(command).toContain('"$OWNER" != "$CURRENT_UID"');
    expect(command).toContain("'/home/user/.skynet/repo-runtime-ownership/");
    expect(command).toContain('printf \'uid=%s\n\' "$CURRENT_UID"');
    expect(command).not.toContain("/root");
    expect(command).not.toContain('"$OWNER" = 1000');
    expect(command).not.toContain('"$OWNER" != 0');
    expect(command).not.toContain("! -uid 0");
    expect(pullCmd(calls)?.env).toEqual({});
    expect(composeBoxCommand(command, undefined, pullCmd(calls)?.env)).not.toContain(SENTINEL);
  });

  test("a non-root retained checkout never replaces a forgeable stale marker", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "owned-stale" });
    const { ctx } = fakeCtx();

    await expect(
      ensureRepoClone(sandbox, BOX_LAYOUT.workdir, "acme/widget", ctx, {
        runtimeLayout: BOX_LAYOUT,
      }),
    ).rejects.toThrow("start a fresh workspace");
    expect(cloneCmd(calls)).toBeUndefined();
  });

  test("a pull request head SHA mismatch fails before provider execution", async () => {
    const expectedHead = "0123456789abcdef0123456789abcdef01234567";
    const actualHead = "89abcdef0123456789abcdef0123456789abcdef";
    const { sandbox } = fakeSandbox({
      pullExit: 1,
      pullOut: `pr:sha-mismatch actual=${actualHead}`,
    });
    const { ctx } = fakeCtx(["acme/widget"]);

    await expect(
      checkoutPullRequestResources(
        sandbox,
        "/w",
        [pullRequestResource(expectedHead)],
        ctx,
      ),
    ).rejects.toThrow(
      `pull request acme/widget#42 head SHA mismatch: expected ${expectedHead}, fetched ${actualHead}`,
    );
  });

  test("a retained agent-owned pull-request checkout is read-only for root", async () => {
    const expectedHead = "0123456789abcdef0123456789abcdef01234567";
    const { sandbox, calls } = fakeSandbox({
      pullExit: 1,
      pullOut: "pr:agent-owned",
    });
    const { ctx } = fakeCtx(["acme/widget"]);

    await expect(
      checkoutPullRequestResources(
        sandbox,
        "/w",
        [pullRequestResource(expectedHead)],
        ctx,
      ),
    ).rejects.toThrow("agent-owned retained checkout; start a fresh workspace");
    const command = pullCmd(calls)?.cmd ?? "";
    expect(command.indexOf('if [ "$OWNER" = 1000 ]')).toBeLessThan(
      command.indexOf("fetch --force"),
    );
  });

  test("an interrupted ownership transfer blocks root pull-request mutation", async () => {
    const expectedHead = "0123456789abcdef0123456789abcdef01234567";
    const { sandbox, calls } = fakeSandbox({
      pullExit: 1,
      pullOut: "pr:ownership-incomplete",
    });
    const { ctx } = fakeCtx(["acme/widget"]);

    await expect(
      checkoutPullRequestResources(
        sandbox,
        "/w",
        [pullRequestResource(expectedHead)],
        ctx,
      ),
    ).rejects.toThrow("partially transferred retained checkout; start a fresh workspace");
    const command = pullCmd(calls)?.cmd ?? "";
    expect(command).toContain(
      'find "$DIR" -xdev \\( ! -uid 0 -o ! -gid 0 -o -perm /022 \\) -print -quit',
    );
    expect(command.indexOf('find "$DIR"')).toBeLessThan(
      command.indexOf("fetch --force"),
    );
  });

  test("an already-matching retained pull-request checkout needs no root mutation", async () => {
    const expectedHead = "0123456789abcdef0123456789abcdef01234567";
    const { sandbox } = fakeSandbox({ pullOut: `pr:reuse sha=${expectedHead}` });
    const { ctx } = fakeCtx(["acme/widget"]);
    expect(await checkoutPullRequestResources(
      sandbox,
      "/w",
      [pullRequestResource(expectedHead)],
      ctx,
    )).toEqual([]);
  });

  test("resources without a code change do not run a checkout command", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { ctx, emits } = fakeCtx();
    const repository: RunResource = {
      kind: "code.repository",
      provider: "github",
      locator: {
        type: "github.repository",
        repository: "acme/widget",
        revision: null,
      },
      capabilities: ["content.read", "code.checkout"],
      provenance: [],
    };

    await checkoutPullRequestResources(sandbox, "/w", [repository], ctx);

    expect(calls).toHaveLength(0);
    expect(emits).toHaveLength(0);
  });

  test("a PR resource without an explicitly selected repo stays API-only", async () => {
    const { sandbox, calls } = fakeSandbox();
    const { ctx, emits } = fakeCtx([]);

    await checkoutPullRequestResources(
      sandbox,
      "/w",
      [pullRequestResource("0123456789abcdef0123456789abcdef01234567")],
      ctx,
    );

    expect(calls).toHaveLength(0);
    expect(emits).toHaveLength(0);
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
    const changed = await ensureRepoClone(sandbox, "/w", "acme/widget", ctx);
    expect(changed).toBe(false);
    expect(cloneCmd(calls)).toBeUndefined();
    expect(emits.some((e) => e.label?.startsWith("Cloning"))).toBe(false);
  });

  test("a missing trusted ownership receipt repairs transfer without repeating Git", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "ownership" });
    const { ctx } = fakeCtx();
    expect(await ensureRepoClone(sandbox, "/w", "acme/widget", ctx)).toBe(true);
    expect(cloneCmd(calls)).toBeUndefined();
    expect(switchCmd(calls)).toBeUndefined();
  });

  test("never mutates an agent-owned retained checkout as root", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "agent-branch" });
    const { ctx } = fakeCtx();
    await expect(
      ensureRepoClone(sandbox, "/w", "acme/widget:main", ctx),
    ).rejects.toThrow("retained agent-owned checkout requires a fresh workspace");
    expect(switchCmd(calls)).toBeUndefined();
  });

  test("SAME repo, WRONG branch: fail closed and require a fresh workspace", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "branch" });
    const { ctx } = fakeCtx();
    await expect(
      ensureRepoClone(sandbox, "/w", "acme/widget:main", ctx),
    ).rejects.toThrow("branch changes require a fresh workspace");
    expect(switchCmd(calls)).toBeUndefined();
    expect(cloneCmd(calls)).toBeUndefined();
  });

  test("an untrusted workspace repository parent fails before placement", async () => {
    const { sandbox, calls } = fakeSandbox({
      state: "absent",
      cloneExit: 1,
      cloneOut: "clone:parent-untrusted",
    });
    const { ctx } = fakeCtx();
    await expect(
      ensureRepoClone(sandbox, "/w", "acme/widget", ctx),
    ).rejects.toThrow("workspace repository parent is not root-owned");
    expect(cloneCmd(calls)?.cmd).toContain('if [ ! -e "$PARENT" ]');
  });

  test("FOREIGN: an UNOWNED git repo with a different origin FAILS CLOSED (never rm, never clone)", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "foreign" });
    const { ctx } = fakeCtx();
    let msg = "";
    await ensureRepoClone(sandbox, "/w", "acme/widget:main", ctx).catch((e) => { msg = e instanceof Error ? e.message : String(e); });
    expect(msg).toContain("refusing to prepare acme/widget");
    expect(msg).toContain("different git repository not created by useAgent");
    expect(cloneCmd(calls)).toBeUndefined();
    expect(switchCmd(calls)).toBeUndefined();
  });

  test("OCCUPIED: UNOWNED non-git content at the destination FAILS CLOSED (never rm, never clone)", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "occupied" });
    const { ctx } = fakeCtx();
    let msg = "";
    await ensureRepoClone(sandbox, "/w", "acme/widget", ctx).catch((e) => { msg = e instanceof Error ? e.message : String(e); });
    expect(msg).toContain("refusing to prepare acme/widget");
    expect(msg).toContain("content not created by useAgent");
    expect(cloneCmd(calls)).toBeUndefined();
  });

  test("OWNED-STALE: a useAgent-owned checkout of a different repo is safe to REPLACE (ALLOW=yes)", async () => {
    const { sandbox, calls } = fakeSandbox({ state: "owned-stale" });
    const { ctx } = fakeCtx();
    await ensureRepoClone(sandbox, "/w", "acme/widget:main", ctx);
    const clone = cloneCmd(calls);
    expect(clone).toBeDefined();
    expect(clone?.cmd).toContain("ALLOW=yes"); // we own it -> may replace
    expect(clone?.cmd).toContain('mktemp -d "$STAGE_ROOT/clone.XXXXXX"');
    expect(clone?.cmd).toContain("-b 'main'");
  });

  test("token redaction: the dev-gated credential rides in ENV only, NEVER in the command string", async () => {
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
