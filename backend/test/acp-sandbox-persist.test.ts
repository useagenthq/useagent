import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { acceptRunCommand } from "../src/commands";
import { getThreadSandbox, setRunSandbox } from "../src/runs/repo";
import "./helpers"; // side-effect: migrate + seed

// Blocker 3: ACP runs must PERSIST their sandbox id (runs.sandbox_id was left NULL), so
// the UI terminal/preview/file lookups, cleanup, recovery and the E2E harness can resolve
// the real sandbox, and a reply reuses the same box. acp-server now calls setRunSandbox on
// every run (created or reused); these exercise that durable mapping via the same
// setRunSandbox / getThreadSandbox path the adapter uses.
const ORG = "org-skynet-dev";

async function enqueue(id: string, threadId: string, parentRunId: string | null): Promise<void> {
  const out = await acceptRunCommand({
    idempotencyKey: null,
    orgId: ORG,
    actorId: null,
    run: { id, prompt: "x", model: "claude-haiku-4-5", engine: "claude", parentRunId, threadId },
  });
  expect(out.status).toBe("created");
}
const sandboxOf = async (id: string): Promise<string | null> => {
  const [r] = await db.select({ s: runs.sandboxId }).from(runs).where(eq(runs.id, id)).limit(1);
  return (r?.s as string | null) ?? null;
};

describe("ACP sandbox_id persistence + reuse (Blocker 3)", () => {
  test("first run stores the sandbox; getThreadSandbox (terminal/preview/file lookup) resolves it", async () => {
    const root = crypto.randomUUID();
    await enqueue(root, root, null);
    expect(await getThreadSandbox(root)).toBeNull(); // nothing persisted yet -> NOT falsely "no sandbox"

    await setRunSandbox(root, "sbx_acp_1");
    expect(await sandboxOf(root)).toBe("sbx_acp_1");
    // the SAME durable read the UI terminal/preview/file endpoints + the E2E cleanup use:
    expect(await getThreadSandbox(root)).toBe("sbx_acp_1");
  });

  test("a reply run REUSES + records the SAME sandbox id (resident thread box)", async () => {
    const root = crypto.randomUUID();
    await enqueue(root, root, null);
    await setRunSandbox(root, "sbx_acp_2");

    const reply = crypto.randomUUID();
    await enqueue(reply, root, root); // same thread, parent = root
    await setRunSandbox(reply, "sbx_acp_2"); // adapter reuses the thread's resident sandbox

    expect(await sandboxOf(reply)).toBe("sbx_acp_2");
    // the thread still resolves to the one shared sandbox (no orphan, no NULL)
    expect(await getThreadSandbox(root)).toBe("sbx_acp_2");
  });

  test("getThreadSandbox returns the MOST RECENT recorded sandbox (thread box can change)", async () => {
    const root = crypto.randomUUID();
    await enqueue(root, root, null);
    await setRunSandbox(root, "sbx_old");
    const reply = crypto.randomUUID();
    await enqueue(reply, root, root);
    await setRunSandbox(reply, "sbx_new"); // e.g. the old box was gone and a fresh one was provisioned
    expect(await getThreadSandbox(root)).toBe("sbx_new");
    // NOTE: acp-server does NOT trust a dead persisted sandbox - daytona.get failure in
    // its durable-reuse path drops to a fresh provision; that live behavior is proven by
    // the Daytona E2E, not unit-testable without a real sandbox.
  });
});
