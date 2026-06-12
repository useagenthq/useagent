import { describe, expect, test } from "bun:test";
import { NativeBridgeSequencer } from "@useagent/agent-harness/bridge";
import type { NativeBridgeFrameBody } from "@useagent/agent-harness/bridge";
import { createSecretRedactor } from "../secrets/redact";
import type { ProviderEventInput } from "../runs/provider-events";
import {
  nativeBridgeSettlement,
  runNativeBridgeTurn,
  safePiBridgeProviderEvent,
} from "./native-bridge-runtime";

describe("native bridge turn settlement", () => {
  const mappedBodies = (frame: unknown): readonly NativeBridgeFrameBody[] =>
    (frame as { bodies?: readonly NativeBridgeFrameBody[] }).bodies ?? [];

  test("provider failure cannot finalize as success", () => {
    expect(nativeBridgeSettlement({ kind: "turn.failed", error: "upstream failed" })).toEqual({
      status: "failed",
      error: "upstream failed",
    });
  });

  test("a child terminal frame cannot settle the parent turn", () => {
    expect(nativeBridgeSettlement({
      kind: "turn.completed",
      ownerChildId: "child-a",
    })).toBeNull();
  });

  test("redacts child transcript tool input and output before persistence", () => {
    const secret = "sk-secret-value-that-must-not-persist";
    const frame = new NativeBridgeSequencer("parent", () => 1).frame({
      kind: "tool.started",
      toolCallId: "tool",
      name: "read",
      input: { token: secret },
      ownerChildId: "child-a",
    });
    const event = safePiBridgeProviderEvent(
      { runId: "run", threadId: "thread" },
      frame,
      createSecretRedactor([secret]),
    );
    expect(JSON.stringify(event.payload)).not.toContain(secret);
    expect(JSON.stringify(event.payload)).toContain("<redacted>");
    const completed = safePiBridgeProviderEvent(
      { runId: "run", threadId: "thread" },
      new NativeBridgeSequencer("parent", () => 1).frame({
        kind: "tool.completed",
        toolCallId: "tool",
        name: "read",
        status: "ok",
        preview: secret,
        ownerChildId: "child-a",
      }),
      createSecretRedactor([secret]),
    );
    expect(JSON.stringify(completed.payload)).not.toContain(secret);
  });

  test("waits for child reconciliation and persists transcript before terminal lifecycle", async () => {
    const captured: ProviderEventInput[] = [];
    let listener: ((frame: unknown) => void) | undefined;
    let reconciled = false;
    const summary = await runNativeBridgeTurn({
      ctx: {
        runId: "run",
        threadId: "thread",
        signal: new AbortController().signal,
        reportActivity: () => {},
      } as never,
      driver: {
        steer: async () => {
          listener?.({
            reconcile: true,
            bodies: [{ kind: "child.completed", childId: "child-a", status: "ok" }],
          });
          listener?.({
            bodies: [
              { kind: "message.authoritative", messageId: "parent", text: "parent final" },
              { kind: "turn.completed" },
            ],
          });
          return { status: "ok" };
        },
        cancel: async () => ({ status: "ok" }),
      } as never,
      session: { nativeSessionId: "parent" } as never,
      bridge: {
        sessionFile: "/sessions/pi.jsonl",
        subscribe: (next) => {
          listener = next;
          return () => {};
        },
        reconcileCompletedChild: (frame) => (frame as { reconcile?: boolean }).reconcile
          ? () => new Promise((resolve) => setTimeout(() => {
              reconciled = true;
              resolve([{
                bodies: [{
                  kind: "message.delta",
                  messageId: "child",
                  text: "child final",
                  ownerChildId: "child-a",
                }],
              }]);
            }, 10))
          : null,
      },
      prompt: "fan out",
      mapFrame: mappedBodies,
      redact: { text: (value) => value, unknown: (value) => value },
    }, async (event) => {
      captured.push(event);
    });

    expect(summary).toBe("parent final");
    expect(reconciled).toBe(true);
    expect(captured.map((event) => [event.eventType, event.nativeSessionId])).toEqual([
      ["part.text", "child-a"],
      ["part.subtask.completed", "parent"],
      ["part.text", "parent"],
      ["pi.turn.completed", "parent"],
    ]);
    expect(captured[1]?.payload).toMatchObject({ transcript: { status: "complete" } });
  });

  test("records redacted transcript failure evidence without failing the parent", async () => {
    const secret = "sk-secret-transcript-error-value";
    const captured: ProviderEventInput[] = [];
    let listener: ((frame: unknown) => void) | undefined;
    const summary = await runNativeBridgeTurn({
      ctx: {
        runId: "run",
        threadId: "thread",
        signal: new AbortController().signal,
      } as never,
      driver: {
        steer: async () => {
          listener?.({
            reconcile: true,
            bodies: [{ kind: "child.completed", childId: "child-a", status: "error" }],
          });
          listener?.({
            bodies: [
              { kind: "message.authoritative", messageId: "parent", text: "parent recovered" },
              { kind: "turn.completed" },
            ],
          });
          return { status: "ok" };
        },
        cancel: async () => ({ status: "ok" }),
      } as never,
      session: { nativeSessionId: "parent" } as never,
      bridge: {
        sessionFile: "/sessions/pi.jsonl",
        subscribe: (next) => {
          listener = next;
          return () => {};
        },
        reconcileCompletedChild: (frame) => (frame as { reconcile?: boolean }).reconcile
          ? () => Promise.reject(new Error(secret))
          : null,
      },
      prompt: "fan out",
      mapFrame: mappedBodies,
      redact: createSecretRedactor([secret]),
    }, async (event) => {
      captured.push(event);
    });

    expect(summary).toBe("parent recovered");
    const terminal = captured.find((event) => event.eventType === "part.subtask.error");
    expect(terminal?.payload).toMatchObject({
      transcript: { status: "failed", error: "<redacted>" },
    });
  });

  test("enforces the remaining transcript drain budget after reconciliation starts", async () => {
    const captured: ProviderEventInput[] = [];
    let listener: ((frame: unknown) => void) | undefined;
    const summary = await runNativeBridgeTurn({
      ctx: {
        runId: "run",
        threadId: "thread",
        signal: new AbortController().signal,
      } as never,
      driver: {
        steer: async () => {
          listener?.({
            reconcile: true,
            bodies: [{ kind: "child.completed", childId: "child-a", status: "ok" }],
          });
          listener?.({
            bodies: [
              { kind: "message.authoritative", messageId: "parent", text: "parent final" },
              { kind: "turn.completed" },
            ],
          });
          return { status: "ok" };
        },
        cancel: async () => ({ status: "ok" }),
      } as never,
      session: { nativeSessionId: "parent" } as never,
      bridge: {
        sessionFile: "/sessions/pi.jsonl",
        subscribe: (next) => {
          listener = next;
          return () => {};
        },
        reconcileCompletedChild: (frame) => (frame as { reconcile?: boolean }).reconcile
          ? () => new Promise((resolve) => setTimeout(() => resolve([]), 50))
          : null,
      },
      prompt: "fan out",
      mapFrame: mappedBodies,
      redact: { text: (value) => value, unknown: (value) => value },
      childTranscriptDrainBudgetMs: 10,
    }, async (event) => {
      captured.push(event);
    });

    expect(summary).toBe("parent final");
    expect(captured.find((event) => event.eventType === "part.subtask.completed")?.payload)
      .toMatchObject({
        transcript: { status: "failed", error: "child transcript drain budget exhausted" },
      });
  });

  test("serializes child reconciliation before starting the next large transcript read", async () => {
    const first = Promise.withResolvers<readonly unknown[]>();
    const started: string[] = [];
    let listener: ((frame: unknown) => void) | undefined;
    const turn = runNativeBridgeTurn({
      ctx: {
        runId: "run",
        threadId: "thread",
        signal: new AbortController().signal,
      } as never,
      driver: {
        steer: async () => {
          listener?.({ childId: "a", bodies: [{ kind: "child.completed", childId: "a", status: "ok" }] });
          listener?.({ childId: "b", bodies: [{ kind: "child.completed", childId: "b", status: "ok" }] });
          listener?.({ bodies: [{ kind: "turn.completed" }] });
          return { status: "ok" };
        },
        cancel: async () => ({ status: "ok" }),
      } as never,
      session: { nativeSessionId: "parent" } as never,
      bridge: {
        sessionFile: "/sessions/pi.jsonl",
        subscribe: (next) => {
          listener = next;
          return () => {};
        },
        reconcileCompletedChild: (frame) => {
          const childId = (frame as { childId?: string }).childId;
          if (!childId) return null;
          return () => {
            started.push(childId);
            return childId === "a" ? first.promise : Promise.resolve([]);
          };
        },
      },
      prompt: "fan out",
      mapFrame: mappedBodies,
      redact: { text: (value) => value, unknown: (value) => value },
    }, async () => {});

    await Promise.resolve();
    expect(started).toEqual(["a"]);
    first.resolve([]);
    await turn;
    expect(started).toEqual(["a", "b"]);
  });

  test("drains child transcript persistence before rethrowing parent failure", async () => {
    const reconciliation = Promise.withResolvers<readonly unknown[]>();
    let listener: ((frame: unknown) => void) | undefined;
    let transcriptPersisted = false;
    const turn = runNativeBridgeTurn({
      ctx: {
        runId: "run",
        threadId: "thread",
        signal: new AbortController().signal,
      } as never,
      driver: {
        steer: async () => {
          listener?.({ reconcile: true, bodies: [{ kind: "child.completed", childId: "a", status: "ok" }] });
          listener?.({ bodies: [{ kind: "turn.failed", error: "parent failed" }] });
          return { status: "ok" };
        },
        cancel: async () => ({ status: "ok" }),
      } as never,
      session: { nativeSessionId: "parent" } as never,
      bridge: {
        sessionFile: "/sessions/pi.jsonl",
        subscribe: (next) => {
          listener = next;
          return () => {};
        },
        reconcileCompletedChild: (frame) => (frame as { reconcile?: boolean }).reconcile
          ? () => reconciliation.promise
          : null,
      },
      prompt: "fan out",
      mapFrame: mappedBodies,
      redact: { text: (value) => value, unknown: (value) => value },
    }, async (event) => {
      if (event.nativeSessionId === "a" && event.eventType === "part.text") {
        transcriptPersisted = true;
      }
    });

    let settled = false;
    void turn.finally(() => {
      settled = true;
    }).catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);
    reconciliation.resolve([{
      bodies: [{
        kind: "message.delta",
        messageId: "child",
        text: "child final",
        ownerChildId: "a",
      }],
    }]);
    await expect(turn).rejects.toThrow("parent failed");
    expect(transcriptPersisted).toBe(true);
  });

  test("required transcript persistence failure cannot be marked complete", async () => {
    const captured: ProviderEventInput[] = [];
    let listener: ((frame: unknown) => void) | undefined;
    const summary = await runNativeBridgeTurn({
      ctx: {
        runId: "run",
        threadId: "thread",
        signal: new AbortController().signal,
      } as never,
      driver: {
        steer: async () => {
          listener?.({ reconcile: true, bodies: [{ kind: "child.completed", childId: "a", status: "ok" }] });
          listener?.({
            bodies: [
              { kind: "message.authoritative", messageId: "parent", text: "parent final" },
              { kind: "turn.completed" },
            ],
          });
          return { status: "ok" };
        },
        cancel: async () => ({ status: "ok" }),
      } as never,
      session: { nativeSessionId: "parent" } as never,
      bridge: {
        sessionFile: "/sessions/pi.jsonl",
        subscribe: (next) => {
          listener = next;
          return () => {};
        },
        reconcileCompletedChild: (frame) => (frame as { reconcile?: boolean }).reconcile
          ? () => Promise.resolve([{
              bodies: [{
                kind: "message.delta",
                messageId: "child",
                text: "child final",
                ownerChildId: "a",
              }],
            }])
          : null,
      },
      prompt: "fan out",
      mapFrame: mappedBodies,
      redact: { text: (value) => value, unknown: (value) => value },
    }, async (event, opts) => {
      if (event.nativeSessionId === "a" && event.eventType === "part.text") {
        if (opts?.required) throw new Error("database unavailable");
        return;
      }
      captured.push(event);
    });

    expect(summary).toBe("parent final");
    const childTerminal = captured.find((event) => event.eventType === "part.subtask.completed");
    expect(childTerminal?.payload).toMatchObject({
      transcript: { status: "failed", error: "database unavailable" },
    });
    expect(JSON.stringify(childTerminal?.payload)).not.toContain('"status":"complete"');
  });

  test("an already-aborted run never dispatches", async () => {
    const controller = new AbortController();
    controller.abort();
    let dispatched = false;
    await expect(runNativeBridgeTurn({
      ctx: {
        runId: "run",
        threadId: "thread",
        signal: controller.signal,
      } as never,
      driver: {
        steer: async () => {
          dispatched = true;
          return { status: "ok" };
        },
        cancel: async () => ({ status: "ok" }),
      } as never,
      session: { nativeSessionId: "session" } as never,
      bridge: { sessionFile: "/sessions/pi.jsonl", subscribe: () => () => {} },
      prompt: "do not dispatch",
      mapFrame: () => [],
      redact: { text: (value) => value, unknown: (value) => value },
    })).rejects.toThrow();
    expect(dispatched).toBe(false);
  });
});
