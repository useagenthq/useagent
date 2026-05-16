import { describe, expect, test } from "bun:test";
import {
  buildT3ThreadSubscriptionRequest,
  decodeT3ThreadStreamItems,
} from "./t3-event-stream";

describe("T3 native thread event stream", () => {
  test("builds the Effect RPC subscribe request with a replay watermark", () => {
    expect(buildT3ThreadSubscriptionRequest("skynet-thread-1", 41)).toEqual({
      _tag: "Request",
      id: 1,
      tag: "orchestration.subscribeThread",
      payload: {
        threadId: "skynet-thread-1",
        afterSequence: 41,
        requestCompletionMarker: true,
      },
      headers: [],
    });
  });

  test("decodes only thread stream items from the matching RPC chunk", () => {
    const items = decodeT3ThreadStreamItems(JSON.stringify({
      _tag: "Chunk",
      requestId: 1,
      values: [
        { kind: "snapshot", snapshot: { snapshotSequence: 42 } },
        { kind: "event", event: { sequence: 43 } },
        { kind: "synchronized" },
        { kind: "unrelated" },
      ],
    }));
    expect(items.map(({ kind }) => kind)).toEqual([
      "snapshot",
      "event",
      "synchronized",
    ]);
    expect(decodeT3ThreadStreamItems('{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success"}}')).toEqual([]);
  });
});
