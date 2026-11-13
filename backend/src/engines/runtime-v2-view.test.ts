// Protocol 2 fixtures built from the runtime contract (upstream ce90eec1f,
// packages/contracts/src/orchestrationV2.ts) and checked on 2026-10-03 against
// frames recorded from runtime dd2b1389590f with Codex and OpenCode 2: every
// field the driver reads matches. Claude, file changes, plans, errors and
// compaction were not yet seen live.
import { describe, expect, test } from "bun:test";
import {
  activityStep,
  hasOpenRuntimeToolCall,
  runtimeActivityProviderEvent,
  runtimeQuestionRequest,
  runtimeTurnError,
  runtimeTurnSettled,
  shouldProjectRuntimeActivity,
} from "./runtime-orchestration";
import { runtimeApprovalRequest } from "./runtime-approval";
import { boundedV2Record, recordedRuntimeActivity, runtimeChildThreadActivities, runtimeThreadView, v2ToolIdentity } from "./runtime-v2-view";
import { PROVIDER_PAYLOAD_CAP_BYTES, serializeProviderPayload } from "../runs/provider-events";
import { createSecretRedactor } from "../secrets/redact";
import {
  v2Item, v2Message, v2Projection, v2ProviderThread, v2Run, v2Session, v2Snapshot, v2Turn,
} from "./runtime-v2.test-support";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

const redact = createSecretRedactor([]);
const ctx = { runId: "run-1", threadId: "thread-1" };

describe("protocol 2 thread view", () => {
  test("the latest run is the turn; its messages keep the run as their turn", () => {
    const view = runtimeThreadView(v2Turn({ sequence: 7, runId: "r2", status: "running", text: "Wor", ordinal: 2 }));
    expect(view.snapshotSequence).toBe(7);
    expect(view.thread.latestTurn).toMatchObject({
      turnId: "r2", state: "running", assistantMessageId: "assistant-r2", userMessageId: `${SANDBOX_NAME_PREFIX}-message-r2`,
    });
    expect(view.thread.messages.map((message) => [message.id, message.role, message.turnId, message.streaming]))
      .toEqual([[`${SANDBOX_NAME_PREFIX}-message-r2`, "user", "r2", false], ["assistant-r2", "assistant", "r2", true]]);
    expect(runtimeTurnSettled(view)).toBe(false);
  });

  test("terminal run statuses settle the turn with their reason", () => {
    const failed = v2Snapshot(3, v2Projection({
      runs: [v2Run({ id: "r1", status: "failed" })],
      turnItems: [v2Item({ id: "e1", type: "error", runId: "r1", failure: { class: "provider_error", message: "rate limited" } })],
    }));
    const view = runtimeThreadView(failed);
    expect(view.thread.latestTurn?.state).toBe("error");
    expect(runtimeTurnSettled(view)).toBe(true);
    for (const status of ["interrupted", "cancelled", "rolled_back"] as const) {
      expect(runtimeThreadView(v2Snapshot(1, v2Projection({ runs: [v2Run({ id: "r", status })] }))).thread.latestTurn?.state)
        .toBe("interrupted");
    }
    const withSession = v2Snapshot(3, v2Projection({
      ...failed.projection,
      providerSessions: [v2Session()],
      providerThreads: [v2ProviderThread()],
    }));
    expect(runtimeTurnError(runtimeThreadView(withSession))).toBe("rate limited");
  });

  test("the active provider session is the thread's session", () => {
    const view = runtimeThreadView(v2Snapshot(1, v2Projection({
      runs: [v2Run({ id: "r1", status: "running" })],
      providerSessions: [v2Session({ id: "ps-old", status: "stopped" }), v2Session({ id: "ps-1", status: "waiting" })],
      providerThreads: [v2ProviderThread()],
    })));
    expect(view.thread.session).toMatchObject({ status: "running", providerSessionId: "ps-1", activeTurnId: "r1" });
    expect(runtimeThreadView(v2Snapshot(1)).thread.session).toBeNull();
  });

  test("tool items become tool lifecycle activities keyed by their item id", () => {
    const running = v2Item({ id: "i1", type: "command_execution", runId: "r1", status: "running", input: "ls -la" });
    const done = v2Item({ id: "i1", type: "command_execution", runId: "r1", status: "completed", input: "ls -la", exitCode: 0 });
    const openView = runtimeThreadView(v2Snapshot(1, v2Projection({ turnItems: [running] })));
    const doneView = runtimeThreadView(v2Snapshot(2, v2Projection({ turnItems: [done] })));
    expect(openView.thread.activities.map((activity) => [activity.id, activity.kind])).toEqual([["i1:updated", "tool.updated"]]);
    expect(doneView.thread.activities.map((activity) => [activity.id, activity.kind])).toEqual([["i1:completed", "tool.completed"]]);
    expect(hasOpenRuntimeToolCall(openView.thread.activities)).toBe(true);
    expect(hasOpenRuntimeToolCall(doneView.thread.activities)).toBe(false);
    const step = activityStep(doneView.thread.activities[0]!, `${SANDBOX_NAME_PREFIX}-thread-thread-1`, "codex");
    expect(step).toMatchObject({ kind: "command", label: "Command run" });
    expect((step.code_json as Record<string, unknown>).input).toEqual({ command: "ls -la" });
    expect((step.code_json as Record<string, unknown>).error).toBe(false);
    expect((step.code_json as { native: { callID: string } }).native.callID).toBe("i1");
  });

  test("a failing command reads as an error even though its output never reaches the plane", () => {
    const failed = runtimeThreadView(v2Snapshot(1, v2Projection({
      turnItems: [v2Item({ id: "i1", type: "command_execution", status: "completed", input: "false", exitCode: 1 })],
    })));
    const step = activityStep(failed.thread.activities[0]!, "t", "codex");
    expect((step.code_json as Record<string, unknown>).error).toBe(true);
  });

  test("dynamic tools name their server and tool for both MCP spellings", () => {
    expect(v2ToolIdentity("useagent-tools.gateway_search")).toEqual({ server: "useagent-tools", tool: "gateway_search" });
    expect(v2ToolIdentity("mcp__useagent-tools__gateway_search")).toEqual({ server: "useagent-tools", tool: "gateway_search" });
    expect(v2ToolIdentity("Read")).toEqual({ server: null, tool: "Read" });
    const view = runtimeThreadView(v2Snapshot(1, v2Projection({
      turnItems: [v2Item({ id: "i2", type: "dynamic_tool", toolName: "mcp__useagent-tools__gateway_search", input: { q: "x" }, output: "found" })],
    })));
    const activity = view.thread.activities[0]!;
    expect(shouldProjectRuntimeActivity(activity, view.thread.activities)).toBe(true);
    const step = activityStep(activity, "t", "claude");
    expect(step.label).toContain("gateway_search");
    expect(step.code_json).toMatchObject({ tool: "gateway_search", server: "useagent-tools", input: { q: "x" }, output: "found" });
  });

  test("file changes carry their paths where the step reads them", () => {
    const view = runtimeThreadView(v2Snapshot(1, v2Projection({
      turnItems: [v2Item({ id: "f1", type: "file_change", fileName: "src/a.ts", changes: [{ operation: "update", path: "src/a.ts" }] })],
    })));
    const step = activityStep(view.thread.activities[0]!, "t", "claude");
    expect(step.kind).toBe("file");
    expect((step.code_json as { input: Record<string, unknown> }).input).toMatchObject({ file_path: "src/a.ts" });
  });

  // The runtime's item schema has `oldStr`, `newStr` and `diffStr`. The pinned
  // runtime (c3a1dd480534) sends none of them for a change that was made, and
  // only `diffStr` for one that failed. These fixtures are what a runtime that
  // sends the two strings would send.
  const fileChange = (overrides: Record<string, unknown>) => runtimeThreadView(v2Snapshot(1, v2Projection({
    turnItems: [v2Item({ id: "f1", type: "file_change", fileName: "/w/src/a.ts", ...overrides })],
  }))).thread.activities[0]!;
  type FileStep = { input: Record<string, unknown>; native: { activity: { data: Record<string, unknown>; v2: Record<string, unknown> } } };
  const fileStep = (activity: ReturnType<typeof fileChange>, redactor = redact) =>
    redactor.unknown(activityStep(recordedRuntimeActivity(activity, redactor), "t", "opencode")).code_json as FileStep;
  const ledger = (activity: ReturnType<typeof fileChange>, redactor = redact) =>
    serializeProviderPayload(runtimeActivityProviderEvent(ctx, "t", activity, redactor).payload)!;
  const count = (text: string, part: string) => text.split(part).length - 1;
  const paths = { files: [{ path: "/w/src/a.ts" }], file_path: "/w/src/a.ts" };
  const unifiedDiff = [
    "Index: /w/src/a.ts",
    "===================================================================",
    "--- /w/src/a.ts",
    "+++ /w/src/a.ts",
    "@@ -1,2 +1,2 @@",
    " export const a = 1;",
    "-export const b = 2;",
    "+export const b = 3;",
  ].join("\n");

  test("a completed change to one file carries the strings it replaced and wrote to its step, once", () => {
    const activity = fileChange({
      oldStr: "export const b = 2;", newStr: "export const b = 3;", diffStr: unifiedDiff, additions: 1, deletions: 1,
    });
    const step = fileStep(activity);
    expect(step.input).toEqual({
      ...paths, additions: 1, deletions: 1, old_string: "export const b = 2;", new_string: "export const b = 3;",
    });
    // Once in the whole step: not in its copy of the activity, nor in the runtime's record there.
    expect(count(JSON.stringify(step), "export const b = 2;")).toBe(1);
    expect(count(JSON.stringify(step), "export const b = 3;")).toBe(1);
    expect(step.native.activity.data).toEqual({ files: [{ path: "/w/src/a.ts" }], additions: 1, deletions: 1 });
    // The ledger holds none of it: its event is the one a change that sent no text gets.
    expect(ledger(activity)).not.toContain("export const b");
    expect(ledger(activity)).toBe(ledger(fileChange({ additions: 1, deletions: 1 })));
    expect(JSON.parse(ledger(activity)).payload).toMatchObject({ itemType: "file_change", toolCallId: "f1" });
  });

  test("a whole file written carries only the string it wrote", () => {
    const step = fileStep(fileChange({ newStr: "export const a = 1;\n" }));
    expect(step.input).toEqual({ ...paths, new_string: "export const a = 1;\n" });
  });

  test("the runtime's diff is never carried, whatever it holds", () => {
    const diffs = [
      unifiedDiff,
      // Codex sends hunks alone; an apply_patch body is another form.
      "@@ -1,2 +1,2 @@\n export const a = 1;\n-export const b = 2;\n+export const b = 3;",
      "*** Begin Patch\n*** Update File: /w/src/a.ts\n@@\n-export const b = 2;\n+export const b = 3;\n*** End Patch",
      // One engine sends the tool's reply here, which is no diff.
      "The file /w/src/a.ts has been updated: export const b = 3;",
    ];
    for (const diffStr of diffs) {
      const activity = fileChange({ diffStr });
      const step = fileStep(activity);
      expect(step.input).toEqual(paths);
      expect(JSON.stringify(step)).not.toContain("export const b");
      expect(ledger(activity)).not.toContain("export const b");
    }
  });

  test("a change that is running, stopped, failed, or names several files carries no text", () => {
    const text = { oldStr: "export const b = 2;", newStr: "export const b = 3;" };
    const cases = [
      { ...text, status: "running" },
      { ...text, status: "interrupted" },
      { ...text, status: "cancelled" },
      { ...text, status: "failed" },
      { ...text, outputIndicatesFailure: true },
      { ...text, exitCode: 1 },
      { ...text, changes: [{ operation: "update", path: "/w/src/a.ts" }, { operation: "add", path: "/w/src/b.ts" }] },
    ];
    for (const overrides of cases) {
      const activity = fileChange(overrides);
      const step = fileStep(activity);
      expect(step.input).not.toHaveProperty("old_string");
      expect(step.input).not.toHaveProperty("new_string");
      expect(step.input.file_path).toBe("/w/src/a.ts");
      expect(JSON.stringify(step)).not.toContain("export const b");
      expect(ledger(activity)).not.toContain("export const b");
    }
    // A failed change keeps what the runtime sends for it today: `diffStr`, the tool's error.
    const failed = fileChange({ status: "failed", diffStr: "Error: oldString not found in /w/src/a.ts" });
    expect(fileStep(failed).native.activity.v2.diffStr).toBe("Error: oldString not found in /w/src/a.ts");
    expect(JSON.parse(ledger(failed)).payload.v2.diffStr).toBe("Error: oldString not found in /w/src/a.ts");
  });

  test("a change's text is kept whole or left out, counted in bytes", () => {
    const whole = "x".repeat(16_384);
    expect(fileStep(fileChange({ newStr: whole })).input.new_string).toBe(whole);
    // 5,461 three-byte characters are 16,383 bytes; one more is 16,386.
    expect(fileStep(fileChange({ newStr: "界".repeat(5_461) })).input.new_string).toBe("界".repeat(5_461));
    const tooLong = [
      { newStr: "x".repeat(16_385) },
      { newStr: "界".repeat(5_462) },
      // The two strings count together and go together, never one of them.
      { oldStr: "x".repeat(8_192), newStr: "y".repeat(8_193) },
    ];
    for (const overrides of tooLong) {
      const step = fileStep(fileChange(overrides));
      expect(step.input).toEqual(paths);
      // Not a piece of it either, anywhere in the step.
      expect(JSON.stringify(step)).not.toMatch(/xxxx|yyyy|界界/);
    }
  });

  test("a change's text cannot push its ledger event over the byte limit", () => {
    // 16,384 bytes as sent, so the step takes them. Redacted, each `test` is ten
    // characters: more than a ledger payload may hold, were the text in it.
    const redactShort = createSecretRedactor(["test"]);
    const activity = fileChange({ newStr: "test".repeat(4_096) });
    const kept = String(fileStep(activity, redactShort).input.new_string);
    expect(kept).toBe("<redacted>".repeat(4_096));
    expect(kept.length).toBeGreaterThan(PROVIDER_PAYLOAD_CAP_BYTES);
    const stored = JSON.parse(ledger(activity, redactShort));
    expect(stored._truncated).toBeUndefined();
    expect(stored.payload.data).toEqual({ files: [{ path: "/w/src/a.ts" }] });
    expect(ledger(activity, redactShort)).toBe(ledger(fileChange({}), redactShort));
  });

  test("a secret in a change's text is redacted in its step, across lines too", () => {
    const secret = "SECRETVALUE-7f3a9c1e5b2d8";
    const lines = "FIRST-LINE-OF-A-VALUE\nSECOND-LINE-OF-A-VALUE";
    const activity = fileChange({
      oldStr: 'export const tenant = "";',
      newStr: `export const tenant = "${secret}";\nexport const block = \`${lines}\`;`,
    });
    // No pattern catches these lines by their shape: only the registered values do.
    const plain = JSON.stringify(fileStep(activity));
    expect(plain).toContain(secret);
    expect(plain).toContain("SECOND-LINE-OF-A-VALUE");
    const safe = JSON.stringify(fileStep(activity, createSecretRedactor([secret, lines])));
    expect(safe).toContain('export const tenant = \\"<redacted>\\";');
    expect(safe).toContain("export const block = `<redacted>`;");
    expect(safe).not.toContain(secret.slice(0, 6));
    expect(safe).not.toContain("LINE-OF-A-VALUE");
  });

  test("a subagent is a task lifecycle owned by its record", () => {
    const view = runtimeThreadView(v2Snapshot(1, v2Projection({
      subagents: [{ id: "sa-1", runId: "r1", childThreadId: "child-1", status: "running", prompt: "look", title: "Explorer", result: null, updatedAt: "x", model: "m" }],
      turnItems: [v2Item({ id: "si-1", type: "subagent", runId: "r1", status: "running", subagentId: "sa-1", childThreadId: "child-1", prompt: "look" })],
    })));
    expect(view.thread.activities.map((entry) => entry.kind)).toEqual(["task.started", "task.progress"]);
    const activity = view.thread.activities[1]!;
    expect(activity.payload).toMatchObject({ taskId: "sa-1", agentKind: "agent", title: "Explorer", childSessionId: "sa-1" });
    const event = runtimeActivityProviderEvent(ctx, `${SANDBOX_NAME_PREFIX}-thread-thread-1`, activity, redact);
    expect(event).toMatchObject({ eventType: "t3.activity.task.progress", nativeSessionId: "sa-1", nativeCallId: "sa-1" });
    // The runtime's own record rides along, untouched.
    expect(activity.payload).toMatchObject({ v2: { id: "si-1", type: "subagent", subagentId: "sa-1" } });
  });

  test("approvals and questions read as requested until their runtime request resolves", () => {
    const approval = v2Item({ id: "a1", type: "approval_request", status: "waiting", requestId: "req-1", requestKind: "command", prompt: "rm -rf build" });
    const question = v2Item({
      id: "q1", type: "user_input_request", status: "waiting", requestId: "req-2",
      questions: [{ id: "color", header: "Color", question: "Pick one", options: [{ label: "Red", description: "warm" }] }],
    });
    const pending = runtimeThreadView(v2Snapshot(1, v2Projection({
      turnItems: [approval, question],
      runtimeRequests: [{ id: "req-1", kind: "command", status: "pending" }, { id: "req-2", kind: "user_input", status: "pending" }],
    })));
    expect(pending.thread.activities.map((activity) => activity.kind)).toEqual(["approval.requested", "user-input.requested"]);
    expect(runtimeApprovalRequest(pending.thread.activities[0]!, "s")).toEqual({
      id: "req-1", sessionID: "s", requestKind: "command", detail: "rm -rf build",
    });
    expect(runtimeQuestionRequest(pending.thread.activities[1]!, "s")?.questions[0]).toMatchObject({ question: "Pick one", header: "Color" });
    const answered = runtimeThreadView(v2Snapshot(2, v2Projection({
      turnItems: [approval],
      runtimeRequests: [{ id: "req-1", kind: "command", status: "resolved", decision: "accept" }],
    })));
    expect(answered.thread.activities.map((activity) => activity.kind)).toEqual(["approval.requested", "approval.resolved"]);
    expect(answered.thread.activities[1]!.payload).toMatchObject({ requestId: "req-1", decision: "accept" });
  });

  test("a todo list is the plan, with running steps in progress", () => {
    const view = runtimeThreadView(v2Snapshot(1, v2Projection({
      turnItems: [v2Item({ id: "p1", type: "todo_list", steps: [{ id: "1", text: "Read", status: "completed" }, { id: "2", text: "Write", status: "running" }] })],
    })));
    const step = activityStep(view.thread.activities[0]!, "t", "codex");
    expect(step.chip).toBe("plan");
    expect((step.code_json as { input: { todos: unknown } }).input.todos).toEqual([
      { content: "Read", status: "completed" }, { content: "Write", status: "in_progress" },
    ]);
  });

  test("a compaction names the message of the run that asked for it", () => {
    const view = runtimeThreadView(v2Snapshot(1, v2Projection({
      runs: [v2Run({ id: "r9", userMessageId: `${SANDBOX_NAME_PREFIX}-message-run-9` })],
      turnItems: [v2Item({ id: "c1", type: "compaction", runId: "r9", status: "completed" })],
    })));
    expect(view.thread.activities[0]).toMatchObject({
      kind: "context-compaction", payload: { state: "compacted", requestId: `${SANDBOX_NAME_PREFIX}-message-run-9` },
    });
  });

  test("a provider thread's context usage is the composer ring's usage frame", () => {
    const view = runtimeThreadView(v2Snapshot(1, v2Projection({
      runs: [v2Run({ id: "r1", providerThreadId: "pt-1" })],
      providerThreads: [v2ProviderThread({ contextUsage: { usedTokens: 1200, maxTokens: 200000, inputTokens: 1000, outputTokens: 200 } })],
    })));
    const usage = view.thread.activities.find((activity) => activity.kind === "context-window.updated")!;
    expect(usage.id).toBe("context:pt-1");
    expect(usage.turnId).toBe("r1");
    const event = runtimeActivityProviderEvent(ctx, "t", usage, redact);
    expect(event).toMatchObject({ eventType: "part.step-finish", payload: { tokens: { total: 1200, input: 1000, output: 200 }, contextWindow: 200000 } });
  });

  test("conversation items the messages already carry are not activities", () => {
    const view = runtimeThreadView(v2Snapshot(1, v2Projection({
      messages: [v2Message({ id: "m1", text: "hi" })],
      turnItems: [
        v2Item({ id: "u1", type: "user_message" }), v2Item({ id: "a1", type: "assistant_message" }),
        v2Item({ id: "r1", type: "reasoning" }), v2Item({ id: "n1", type: "system_notice" }),
      ],
    })));
    expect(view.thread.activities).toEqual([]);
  });

  test("the runtime's record rides along bounded, so a huge item never blanks the payload the plane reads", () => {
    const huge = "x".repeat(200_000);
    const approval = v2Item({
      id: "a-huge", type: "approval_request", status: "waiting", requestId: "req-huge", requestKind: "command",
      prompt: huge, options: Array.from({ length: 500 }, (_, index) => ({ decision: "accept", label: `option ${index}` })),
    });
    const view = runtimeThreadView(v2Snapshot(1, v2Projection({
      turnItems: [approval], runtimeRequests: [{ id: "req-huge", kind: "command", status: "pending" }],
    })));
    const event = runtimeActivityProviderEvent(ctx, "t", view.thread.activities[0]!, redact);
    const stored = JSON.parse(serializeProviderPayload(event.payload)!);
    expect(stored._truncated).toBeUndefined();
    expect(stored).toMatchObject({ id: "req-huge", requestKind: "command" });

    const tool = v2Item({ id: "t-huge", type: "dynamic_tool", status: "completed", toolName: "Read", input: { blob: huge }, output: huge });
    const toolActivity = runtimeThreadView(v2Snapshot(1, v2Projection({ turnItems: [tool] }))).thread.activities[0]!;
    const step = activityStep(recordedRuntimeActivity(toolActivity, redact), "t", "claude");
    expect(JSON.stringify(step.code_json).length).toBeLessThan(40_000);
  });

  test("message context and attachments never ride along, and an oversized record keeps only its identity", () => {
    const message = v2Message({ id: "c-msg", text: "y".repeat(5_000), context: { files: ["secret.env"] }, attachments: [{ id: "f1" }] } as never);
    const [childMessage] = runtimeChildThreadActivities(v2Snapshot(1, v2Projection({ messages: [message] }, "child")), "parent", "sa-1");
    const record = (recordedRuntimeActivity(childMessage!, redact).payload as { v2: Record<string, unknown> }).v2;
    expect(record).not.toHaveProperty("context");
    expect(record).not.toHaveProperty("attachments");
    expect(String(record.text).length).toBeLessThanOrEqual(1_000);
    expect((childMessage!.payload as { text: string }).text).toHaveLength(5_000);

    const wide = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field${index}`, "z".repeat(900)]));
    expect(boundedV2Record({ id: "w", type: "dynamic_tool", status: "running", ...wide }, redact))
      .toEqual({ id: "w", type: "dynamic_tool", status: "running", truncated: true });
  });

  test("a secret across a cut is redacted whole before anything is cut", () => {
    const secret = "SECRETVALUE-7f3a9c1e5b2d8";
    const key = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";
    const redactSecret = createSecretRedactor([secret]);
    // The secret sits across the record's string cut (1,000) and the detail cut (4,000); the key across the input cut.
    const prompt = `${"a".repeat(990)}${secret}${"b".repeat(2_975)}${secret}${"c".repeat(100)}`;
    const view = runtimeThreadView(v2Snapshot(1, v2Projection({
      turnItems: [
        v2Item({ id: "a-cut", type: "approval_request", status: "waiting", requestId: "req-cut", requestKind: "command", prompt }),
        v2Item({ id: "t-cut", type: "dynamic_tool", status: "completed", toolName: "Search", input: { query: `${"q".repeat(3_990)} ${key}` }, output: prompt }),
      ],
      runtimeRequests: [{ id: "req-cut", kind: "command", status: "pending" }],
    })));
    expect(view.thread.activities.map((activity) => activity.kind)).toEqual(["approval.requested", "tool.completed"]);
    const stored = view.thread.activities.flatMap((activity) => [
      serializeProviderPayload(runtimeActivityProviderEvent(ctx, "t", activity, redactSecret).payload)!,
      JSON.stringify(redactSecret.unknown(activityStep(recordedRuntimeActivity(activity, redactSecret), "t", "claude")).code_json),
    ]).join("\n");
    expect(stored).toContain("<redacted>");
    expect(stored).not.toContain(secret.slice(0, 6));
    expect(stored).not.toContain(key.slice(0, 8));
  });
});
