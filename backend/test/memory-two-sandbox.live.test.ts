import { describe, expect, test } from "bun:test";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { executeMemoryTool } from "../src/knowledge/gateway/memory-tools";
import type { ToolTokenClaims } from "../src/knowledge/gateway/token";
import { uid } from "./helpers";

// LIVE defining proof (new_mem_prompt.md 12.3 + 12.4) against the INSTALLED
// Tencent memory-core at MEMORY_API_URL. Two genuinely independent runs (= two
// sandboxes at the identity layer) share memory through the gateway tools:
// remember in run A -> IMMEDIATE recall in run B from Tencent L0, before L1
// extraction, with a provider citation and NO Postgres/memory.md dependence.
// Plus org isolation. The Daytona-sandbox network hop is gated separately on
// TOOL_GATEWAY_PUBLIC_URL; this proves the authoritative layer end to end.
//
// Guarded: if :8420 is unreachable the tests SKIP (bun marks them skipped, not
// passed) so a Tencent-less CI never prints a misleading PASS (12.7).

const GATEWAY = (process.env.MEMORY_API_URL ?? "").replace(/\/+$/, "");

async function probe(): Promise<boolean> {
  if (!GATEWAY) return false;
  try {
    const res = await fetch(`${GATEWAY}/v3/conversation/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MEMORY_API_KEY ?? ""}`,
        "x-tdai-service-id": process.env.MEMORY_SERVICE_ID ?? "skynet",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ team_id: "skynet", agent_id: "skynet-backend", user_id: "org:skynet", query: "ping", limit: 1 }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const LIVE = await probe();
if (!LIVE) console.warn(`[two-sandbox.live] SKIPPED - Tencent gateway ${GATEWAY || "(unset)"} unreachable`);

/** A distinct org per test-run so we never collide with real pools or each other. */
function freshOrg(): string {
  return `e2e-${uid("org").slice(-10)}`;
}

async function insertRun(orgId: string, scope: "org" | "personal", userId: string | null) {
  const id = uid("run");
  await db.insert(runs).values({
    id,
    prompt: "hi",
    model: "claude-opus-5",
    engine: "opencode",
    status: "running",
    threadId: id, // distinct thread == distinct sandbox
    orgId,
    userId,
    memoryScope: scope,
  });
  return { id, threadId: id };
}
function claims(run: { id: string; threadId: string }, orgId: string, userId = "u-1"): ToolTokenClaims {
  return { orgId, userId, threadId: run.threadId, runId: run.id, exp: Date.now() + 60_000 };
}

describe.skipIf(!LIVE)("two-sandbox memory continuity (live Tencent)", () => {
  test("remember in sandbox A -> immediate L0 recall in sandbox B, isolated from another org", async () => {
    const orgA = freshOrg();
    const marker = `teal-${uid("m").slice(-8)}`;

    // Sandbox A: the user says "remember my favourite color".
    const a = await insertRun(orgA, "org", "u-1");
    const remembered = await executeMemoryTool(claims(a, orgA), "memory_remember", {
      content: `The user's favourite color is ${marker}.`,
      kind: "preference",
      key: "favourite_color",
    });
    expect(remembered.structuredContent?.saved).toBe(true);
    const refs = remembered.structuredContent?.refs as string[];
    expect(refs?.[0]).toMatch(/^tencent:l0:/); // real accepted_ids receipt

    // Sandbox B: a DIFFERENT run/thread in the same org, immediately, no wait for L1.
    const b = await insertRun(orgA, "org", "u-2");
    const recalled = await executeMemoryTool(claims(b, orgA, "u-2"), "memory_search", {
      query: "what is my favourite color",
    });
    const items = (recalled.structuredContent?.items ?? []) as Array<{ content: string; layer: string; ref: string }>;
    const hit = items.find((i) => i.content.includes(marker));
    expect(hit).toBeDefined(); // recalled across sandboxes from Tencent
    expect(hit?.layer).toBe("l0"); // immediately, from L0 ground evidence
    expect(hit?.ref).toMatch(/^tencent:l0:/);

    // Isolation: a run in a DIFFERENT org must NOT see orgA's memory.
    const orgB = freshOrg();
    const other = await insertRun(orgB, "org", "u-9");
    const otherRecall = await executeMemoryTool(claims(other, orgB, "u-9"), "memory_search", {
      query: "what is my favourite color",
    });
    const otherItems = (otherRecall.structuredContent?.items ?? []) as Array<{ content: string }>;
    expect(otherItems.some((i) => i.content.includes(marker))).toBe(false);
  }, 20_000);
});
