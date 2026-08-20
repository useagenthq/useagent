import { describe, expect, test } from "bun:test";
import { enqueue, getByKey } from "../src/slack/outbox/repo";
import { uid } from "./helpers";

describe("slack outbox payload bounding", () => {
  test("an oversized reply truncates the TEXT FIELD, never the serialized JSON", async () => {
    const key = `bounds:${uid("k")}`;
    const created = await enqueue({
      kind: "post_message",
      idempotencyKey: key,
      payload: { channel: "C1", text: "x".repeat(9_000), threadTs: "1.1" },
    });
    expect(created).toBe(true);
    const row = await getByKey(key);
    const payload = JSON.parse(row!.payload) as { text: string; channel: string; threadTs: string };
    expect(payload.channel).toBe("C1");
    expect(payload.threadTs).toBe("1.1");
    expect(payload.text.endsWith("... (truncated; full reply in the app)")).toBe(true);
    expect(row!.payload.length).toBeLessThanOrEqual(8_192);
  });
});
