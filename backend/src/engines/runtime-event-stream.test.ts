import { describe, expect, test } from "bun:test";
import {
  buildRuntimeThreadSubscriptionRequest,
  decodeRuntimeThreadStreamItems,
} from "./runtime-event-stream";

describe("T3 native thread event stream", () => {
  test("builds the Effect RPC subscribe request with a replay watermark", () => {
    expect(buildRuntimeThreadSubscriptionRequest("skynet-thread-1", 41)).toEqual({
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
    const items = decodeRuntimeThreadStreamItems(JSON.stringify({
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
    expect(decodeRuntimeThreadStreamItems('{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success"}}')).toEqual([]);
  });
});
