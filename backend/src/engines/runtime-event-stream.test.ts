import { describe, expect, test } from "bun:test";
import {
  buildRuntimeThreadSubscriptionRequest,
  decodeRuntimeThreadStreamItems,
  followRuntimeThreadSnapshots,
  type RuntimeThreadStreamItem,
} from "./runtime-event-stream";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";

function snapshot(sequence: number): RuntimeThreadSnapshot {
  return {
    snapshotSequence: sequence,
    thread: {
      id: "skynet-thread-1",
      latestTurn: null,
      messages: [],
      activities: [],
      session: null,
    },
  };
}

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

  test("requests an authoritative websocket snapshot when no replay watermark is supplied", () => {
    expect(buildRuntimeThreadSubscriptionRequest("skynet-thread-1")).toEqual({
      _tag: "Request",
      id: 1,
      tag: "orchestration.subscribeThread",
      payload: {
        threadId: "skynet-thread-1",
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
        {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: 42,
            thread: {
              id: "skynet-thread-1",
              latestTurn: null,
              messages: [],
              activities: [],
              session: null,
            },
          },
        },
        {
          kind: "event",
          event: {
            sequence: 43,
            aggregateKind: "thread",
            aggregateId: "skynet-thread-1",
          },
        },
        { kind: "synchronized" },
        { kind: "snapshot", snapshot: { snapshotSequence: 44 } },
        { kind: "event", event: { sequence: 45, aggregateId: "skynet-thread-1" } },
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

  test("serializes a delayed refresh snapshot before a newer websocket snapshot", async () => {
    const applied: number[] = [];
    const lowerStarted = Promise.withResolvers<void>();
    const releaseLower = Promise.withResolvers<void>();

    await followRuntimeThreadSnapshots({
      sandbox: {} as never,
      threadId: "skynet-thread-1",
      initialSequence: 0,
      signal: new AbortController().signal,
      readSnapshot: async () => snapshot(1),
      applySnapshot: async (value) => {
        if (value.snapshotSequence === 1) {
          lowerStarted.resolve();
          await releaseLower.promise;
        }
        applied.push(value.snapshotSequence);
        return value.snapshotSequence !== 2;
      },
      subscribe: async (_sandbox, _threadId, _after, _signal, onItem) => {
        expect(await onItem({
          kind: "event",
          event: { sequence: 1, aggregateKind: "thread", aggregateId: "skynet-thread-1" },
        })).toBe(true);
        await lowerStarted.promise;
        const newer = onItem({ kind: "snapshot", snapshot: snapshot(2) });
        releaseLower.resolve();
        expect(await newer).toBe(false);
      },
    });

    expect(applied).toEqual([1, 2]);
  });

  test("does not apply a queued snapshot after a terminal snapshot stops following", async () => {
    const applied: number[] = [];
    const terminalStarted = Promise.withResolvers<void>();
    const releaseTerminal = Promise.withResolvers<void>();

    await followRuntimeThreadSnapshots({
      sandbox: {} as never,
      threadId: "skynet-thread-1",
      initialSequence: 0,
      signal: new AbortController().signal,
      readSnapshot: async () => {
        throw new Error("unexpected refresh");
      },
      applySnapshot: async (value) => {
        applied.push(value.snapshotSequence);
        terminalStarted.resolve();
        await releaseTerminal.promise;
        return false;
      },
      subscribe: async (
        _sandbox,
        _threadId,
        _after,
        _signal,
        onItem: (item: RuntimeThreadStreamItem) => Promise<boolean>,
      ) => {
        const terminal = onItem({ kind: "snapshot", snapshot: snapshot(1) });
        await terminalStarted.promise;
        const late = onItem({ kind: "snapshot", snapshot: snapshot(2) });
        releaseTerminal.resolve();
        expect(await terminal).toBe(false);
        expect(await late).toBe(false);
      },
    });

    expect(applied).toEqual([1]);
  });

  test.each([true, false])("settles a pending refresh before a socket failure (terminal=%s)", async (terminal) => {
    const applied: number[] = [];
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const socketError = new Error("socket closed");
    const following = followRuntimeThreadSnapshots({
      sandbox: {} as never,
      threadId: "skynet-thread-1",
      initialSequence: 0,
      signal: new AbortController().signal,
      readSnapshot: async () => {
        readStarted.resolve();
        await releaseRead.promise;
        return snapshot(1);
      },
      applySnapshot: async (value) => {
        applied.push(value.snapshotSequence);
        return !terminal;
      },
      subscribe: async (_sandbox, _threadId, _after, _signal, onItem) => {
        await onItem({
          kind: "event",
          event: { sequence: 1, aggregateKind: "thread", aggregateId: "skynet-thread-1" },
        });
        await readStarted.promise;
        releaseRead.resolve();
        throw socketError;
      },
    });

    if (terminal) await expect(following).resolves.toBeUndefined();
    else await expect(following).rejects.toBe(socketError);
    expect(applied).toEqual([1]);
  });

  test("rejects an unsolicited successful stream exit after only a running snapshot", async () => {
    await expect(followRuntimeThreadSnapshots({
      sandbox: {} as never,
      threadId: "skynet-thread-1",
      initialSequence: 0,
      signal: new AbortController().signal,
      readSnapshot: async () => {
        throw new Error("unexpected refresh");
      },
      applySnapshot: async () => true,
      subscribe: async (_sandbox, _threadId, _after, _signal, onItem) => {
        expect(await onItem({ kind: "snapshot", snapshot: snapshot(1) })).toBe(true);
        // Models an unsolicited Effect RPC Exit Success.
      },
    })).rejects.toThrow("ended before a terminal snapshot");
  });
});
