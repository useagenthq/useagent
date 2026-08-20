import { describe, expect, test } from "bun:test";
import { enqueue, getByKey } from "../src/slack/outbox/repo";
import { enqueuePostMessage, getSlackOutbox } from "../src/slack/outbox";
import { uid } from "./helpers";

describe("slack outbox payload bounding", () => {
  test("a long reply is CHUNKED into sequential messages, never truncated", async () => {
    const key = `bounds:${uid("k")}`;
    // ~12k chars of paragraphs - held whole by the old truncation cap, now split.
    const text = Array.from({ length: 60 }, (_, i) => `paragraph ${i} ${"x".repeat(180)}`).join("\n\n");
    await enqueuePostMessage({ idempotencyKey: key, channel: "C1", text, threadTs: "1.1" });
    const row = await getSlackOutbox(key);
    const payload = JSON.parse(row!.payload) as { chunks: string[]; channel: string; threadTs: string };
    expect(payload.channel).toBe("C1");
    expect(payload.threadTs).toBe("1.1");
    expect(payload.chunks.length).toBeGreaterThan(1);
    for (const chunk of payload.chunks) expect(chunk.length).toBeLessThanOrEqual(3900);
    // Nothing was dropped: the full text survives across the chunks.
    expect(payload.chunks.join("").includes("paragraph 59")).toBe(true);
  });

  test("a payload that cannot fit sheds WHOLE trailing chunks with an honest marker", async () => {
    const key = `bounds:${uid("k")}`;
    // Direct repo enqueue with more chunk bytes than the 48k payload cap.
    const chunks = Array.from({ length: 20 }, (_, i) => `chunk ${i} ${"y".repeat(3000)}`);
    const created = await enqueue({
      kind: "post_message",
      idempotencyKey: key,
      payload: { channel: "C1", chunks, threadTs: "1.1" },
    });
    expect(created).toBe(true);
    const row = await getByKey(key);
    expect(row!.payload.length).toBeLessThanOrEqual(48_000);
    const payload = JSON.parse(row!.payload) as { chunks: string[] };
    expect(payload.chunks.length).toBeLessThan(20);
    expect(payload.chunks.at(-1)!.endsWith("_(truncated; full reply in the app)_")).toBe(true);
    // Chunks are shed whole - every kept one is intact.
    for (const [i, chunk] of payload.chunks.entries()) expect(chunk.startsWith(`chunk ${i} `)).toBe(true);
  });
});
