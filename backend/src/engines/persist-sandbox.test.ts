import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { persistSandboxBeforeExecution } from "./util";

// P1-B: a run's sandbox association is durable BEFORE execution, fail-closed. These prove the
// pure policy both adapters share: persist -> continue; persist fails -> abort the turn; a box
// we just provisioned is torn down (no leak); a reused resident box is preserved; and the
// thrown error never carries the raw persistence error (which can embed a DB connection string).
describe("persistSandboxBeforeExecution (P1-B: persist-before-execution, fail-closed)", () => {
  test("persist succeeds -> resolves and does NOT delete the box (turn proceeds)", async () => {
    const deleteFresh = mock(async () => {});
    const persist = mock(async (_runId: string, _sandboxId: string) => {});
    await persistSandboxBeforeExecution({
      runId: "r1",
      sandboxId: "sbx1",
      reused: false,
      persist,
      deleteFreshSandbox: deleteFresh,
    });
    expect(persist).toHaveBeenCalledWith("r1", "sbx1"); // recorded before returning
    expect(deleteFresh).toHaveBeenCalledTimes(0);
  });

  test("persist FAILS on a freshly provisioned box -> throws (aborts the turn) AND tears the box down", async () => {
    const deleteFresh = mock(async () => {});
    const p = persistSandboxBeforeExecution({
      runId: "r2",
      sandboxId: "sbx2",
      reused: false,
      persist: async () => { throw new Error("db down"); },
      deleteFreshSandbox: deleteFresh,
    });
    await expect(p).rejects.toThrow(/aborting run r2/);
    expect(deleteFresh).toHaveBeenCalledTimes(1); // newly provisioned box cleaned up (no leak)
  });

  test("the thrown error NEVER carries the raw persistence error (no connection-string / credential leak)", async () => {
    let msg = "";
    await persistSandboxBeforeExecution({
      runId: "r3",
      sandboxId: "sbx3",
      reused: false,
      persist: async () => { throw new Error("connect ECONNREFUSED postgres://user:SUPERSECRET@10.0.0.1:5432/skynet"); },
      deleteFreshSandbox: async () => {},
    }).catch((e) => { msg = e instanceof Error ? e.message : String(e); });
    expect(msg).not.toContain("SUPERSECRET");
    expect(msg).not.toContain("postgres://");
    expect(msg).toContain("fail-closed");
  });

  test("persist FAILS on a REUSED resident box -> throws but does NOT delete it (resident reuse preserved)", async () => {
    const deleteFresh = mock(async () => {});
    const p = persistSandboxBeforeExecution({
      runId: "r4",
      sandboxId: "sbx4",
      reused: true,
      persist: async () => { throw new Error("db hiccup"); },
      deleteFreshSandbox: deleteFresh,
    });
    await expect(p).rejects.toThrow(/aborting run r4/);
    expect(deleteFresh).toHaveBeenCalledTimes(0); // a resident thread box is never destroyed here
  });

  test("a cleanup failure does not mask the fail-closed abort (the turn still aborts)", async () => {
    const p = persistSandboxBeforeExecution({
      runId: "r5",
      sandboxId: "sbx5",
      reused: false,
      persist: async () => { throw new Error("db down"); },
      deleteFreshSandbox: async () => { throw new Error("daytona delete failed"); },
    });
    await expect(p).rejects.toThrow(/aborting run r5/);
  });
});

// Static guard: BOTH adapters must go through the shared fail-closed helper and must NOT leave
// a fire-and-forget `void setRunSandbox(...)` in an execution path (the P1-B regression).
describe("both engine adapters obey the persistence-before-execution invariant (static guard)", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const acp = read("./acp-server.ts");
  const opencode = read("./opencode-server.ts");

  test("ACP awaits persistSandboxBeforeExecution and has no fire-and-forget setRunSandbox", () => {
    expect(acp).toContain("await persistSandboxBeforeExecution({");
    expect(acp).not.toMatch(/void\s+setRunSandbox\(/);
  });

  test("OpenCode awaits persistSandboxBeforeExecution and has no fire-and-forget setRunSandbox", () => {
    expect(opencode).toContain("await persistSandboxBeforeExecution({");
    expect(opencode).not.toMatch(/void\s+setRunSandbox\(/);
  });

  test("ACP clears the fresh sandbox ref on a persist failure so the finally cannot double-delete", () => {
    // fresh path: the helper tears the box down once; ACP nulls `sandbox` before rethrow so the
    // run's finally (which also deletes on !succeeded) does not delete the SAME box a 2nd time.
    // Guarded on `!retainForThread` so the reused-sandbox lifecycle is untouched.
    expect(acp).toMatch(/if \(!retainForThread\) sandbox = null;/);
  });

  test("persistence is awaited BEFORE the engine prepares/boots (ordering, both adapters)", () => {
    // ACP: persist precedes per-run provider/repo preparation.
    expect(acp.indexOf("await persistSandboxBeforeExecution({")).toBeLessThan(
      acp.indexOf("cfg.prepare?.(box, ctx)"),
    );
    expect(acp).toContain("const [, secretState] = await stagesTogether([");
    // OpenCode: persist precedes wiring the knowledge gateway + booting `opencode serve`.
    expect(opencode.indexOf("await persistSandboxBeforeExecution({")).toBeLessThan(
      opencode.indexOf("prepareOpencodeSandboxConfig(box, ctx, baseOpenCodeConfig)"),
    );
  });

  test("both resident adapters publish the live SDK object only after durable persistence", () => {
    expect(acp.indexOf("await persistSandboxBeforeExecution({")).toBeLessThan(
      acp.indexOf("rememberLiveThreadSandbox(ctx.threadId, box)"),
    );
    expect(opencode.indexOf("await persistSandboxBeforeExecution({")).toBeLessThan(
      opencode.indexOf("rememberLiveThreadSandbox(ctx.threadId, box)"),
    );
  });
});
