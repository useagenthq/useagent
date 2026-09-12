import { describe, expect, test } from "bun:test";
import { db } from "../db/client";
import { runs } from "../db/schema";
import { getThreadProviderSessionState } from "./provider-session-repo";
import "../index";

describe("getThreadProviderSessionState", () => {
  test("requires exact organization, thread, and engine", async () => {
    const threadId = crypto.randomUUID();
    const orgA = `org-a-${crypto.randomUUID()}`;
    const orgB = `org-b-${crypto.randomUUID()}`;
    await db.insert(runs).values([
      {
        id: crypto.randomUUID(), orgId: orgA, userId: "user-a", prompt: "a", model: "gpt-5.6-sol",
        engine: "codex", status: "completed", threadId, engineSessionId: "session-a",
      },
      {
        id: crypto.randomUUID(), orgId: orgB, userId: "user-b", prompt: "b", model: "gpt-5.6-sol",
        engine: "codex", status: "completed", threadId, engineSessionId: "session-b",
      },
    ]);
    expect((await getThreadProviderSessionState(orgA, threadId, "codex", "none")).legacySessionId).toBe("session-a");
    expect((await getThreadProviderSessionState("org-c", threadId, "codex", "none")).legacySessionId).toBeNull();
  });

  test("preserves legacy null-org resume without crossing into tenant rows", async () => {
    const threadId = crypto.randomUUID();
    await db.insert(runs).values({
      id: crypto.randomUUID(), orgId: null, userId: null, prompt: "legacy", model: "gpt-5.6-sol",
      engine: "codex", status: "completed", threadId, engineSessionId: "legacy-session",
    });
    expect((await getThreadProviderSessionState(null, threadId, "codex", "none")).legacySessionId).toBe("legacy-session");
    expect((await getThreadProviderSessionState(`org-${crypto.randomUUID()}`, threadId, "codex", "none")).legacySessionId).toBeNull();
  });
});
