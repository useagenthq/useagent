import { describe, expect, test } from "bun:test";
import {
  activityStep,
  assistantText,
  hasOpenRuntimeToolCall,
  buildRuntimeProjectCreateCommand,
  buildRuntimeThreadCreateCommand,
  buildRuntimeTurnInterruptCommand,
  buildRuntimeTurnStartCommand,
  runtimeActivityProviderEvent,
  runtimeActivityRevision,
  runtimeActivityStepKey,
  shouldProjectRuntimeActivity,
  runtimeModelId,
  runtimeQuestionRequest,
  runtimeProjectId,
  runtimeThreadId,
  runtimeTurnError,
  runtimeTurnSettled,
  type RuntimeThreadSnapshot,
} from "./runtime-orchestration";
import { createSecretRedactor } from "../secrets/redact";
import { CEREBRAS_QWEN_MODEL, DEEPSEEK_V4_FLASH_MODEL } from "../runs/model-policy";
import { makeNativeFrame } from "../runs/native-events";
import { translateOpenCode } from "./opencode-canonical";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";
import { LEGACY_TOOL_SERVER_IDS } from "@useagent/agent-harness/canonical";

const context = { runId: "run/unsafe", threadId: "thread unsafe", model: "gpt-5.6-luna" };
const baselineRedactor = createSecretRedactor([]);

describe("T3 orchestration projection", () => {
  test("interrupts a run by its id, never a whole thread", () => {
    const command = buildRuntimeTurnInterruptCommand(`${SANDBOX_NAME_PREFIX}-thread-1`, "run-7", "turn aborted");
    expect(command).toMatchObject({ type: "run.interrupt", threadId: `${SANDBOX_NAME_PREFIX}-thread-1`, runId: "run-7", reason: "turn aborted" });
    expect(command.commandId).toStartWith(`${SANDBOX_NAME_PREFIX}-turn-interrupt-`);
    expect(buildRuntimeTurnInterruptCommand("t", "r").commandId).not.toBe(buildRuntimeTurnInterruptCommand("t", "r").commandId);
  });

  test("derives stable transport-safe project and thread ids", () => {
    expect(runtimeProjectId(context)).toBe(`${SANDBOX_NAME_PREFIX}-project-thread-unsafe`);
    expect(runtimeThreadId(context)).toBe(`${SANDBOX_NAME_PREFIX}-thread-thread-unsafe`);
  });

  test("sends the run's message to start now, as the plane's own message", () => {
    const command = buildRuntimeTurnStartCommand(context, "codex", "use every prompt without keyword routing");
    expect(command).toMatchObject({
      type: "message.dispatch",
      commandId: `${SANDBOX_NAME_PREFIX}-turn-run-unsafe`,
      threadId: `${SANDBOX_NAME_PREFIX}-thread-thread-unsafe`,
      messageId: `${SANDBOX_NAME_PREFIX}-message-run-unsafe`,
      text: "use every prompt without keyword routing",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
      modelSelection: { instanceId: "codex", model: "gpt-5.6-luna", options: [] },
    });
    // The mode lives on the thread; protocol 2 commands carry no client clock.
    expect(command).not.toHaveProperty("runtimeMode");
    expect(command).not.toHaveProperty("createdAt");
    expect(command).not.toHaveProperty("bootstrap");
  });

  test("never builds a fork or a merge-back: branching stays with the plane", async () => {
    const source = await Bun.file(new URL("./runtime-v2-wire.ts", import.meta.url)).text();
    expect(source).not.toContain("thread.fork");
    expect(source).not.toContain("thread.merge_back");
    expect(source).not.toContain("restoreFiles");
  });

  test("builds an explicit thread before the turn is dispatched", () => {
    expect(
      buildRuntimeThreadCreateCommand(
        { runId: "run-1", threadId: "thread-1", model: "gpt-5.6-luna" },
        "codex",
      ),
    ).toMatchObject({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      threadId: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      projectId: `${SANDBOX_NAME_PREFIX}-project-thread-1`,
      modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
      runtimeMode: "full-access",
    });
  });

  test("maps UseAgent OpenCode catalog ids onto T3 provider-qualified ids", () => {
    expect(runtimeModelId("opencode", "openai/gpt-5.6-luna")).toBe(
      "openai/gpt-5.6-luna",
    );
    expect(runtimeModelId("opencode", "anthropic/claude-opus-5")).toBe(
      "anthropic/claude-opus-5",
    );
    expect(runtimeModelId("opencode", "moonshotai/kimi-k3")).toBe(
      "openrouter/moonshotai/kimi-k3",
    );
    expect(runtimeModelId("opencode", DEEPSEEK_V4_FLASH_MODEL)).toBe(
      "openrouter/deepseek/deepseek-v4-flash",
    );
    expect(runtimeModelId("opencode", "rotated/model:free")).toBe(
      "openrouter/rotated/model:free",
    );
    expect(runtimeModelId("opencode", "claude-opus-5")).toBe(
      "anthropic/claude-opus-5",
    );
    expect(runtimeModelId("opencode", "openrouter/openai/gpt-5.6-luna")).toBe(
      "openrouter/openai/gpt-5.6-luna",
    );
    expect(runtimeModelId("opencode", CEREBRAS_QWEN_MODEL)).toBe(
      "cerebras/qwen-3.8-27b",
    );
    expect(() => runtimeModelId("opencode", "unknown/model")).toThrow(
      "Unsupported OpenCode model provider: unknown",
    );
    expect(runtimeModelId("codex", "gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });

  test("sends a Cerebras-qualified selection unchanged to native OpenCode", () => {
    const opencodeContext = {
      runId: "run-cerebras",
      threadId: "thread-cerebras",
      model: CEREBRAS_QWEN_MODEL,
    };
    expect(
      buildRuntimeThreadCreateCommand(
        opencodeContext,
        "opencode",
      ),
    ).toMatchObject({
      modelSelection: {
        instanceId: "opencode",
        model: "cerebras/qwen-3.8-27b",
      },
    });
    expect(
      buildRuntimeTurnStartCommand(
        opencodeContext,
        "opencode",
        "test",
      ),
    ).toMatchObject({
      modelSelection: {
        instanceId: "opencode",
        model: "cerebras/qwen-3.8-27b",
      },
    });
  });

  test("normalizes T3 approval activities into the durable approval lane", () => {
    const activity = {
      id: "activity-approval",
      tone: "approval" as const,
      kind: "approval.requested",
      summary: "Command approval requested",
      payload: {
        requestId: "approval-1",
        requestKind: "command",
        detail: "git status",
      },
      turnId: "turn-1",
    };
    expect(runtimeActivityProviderEvent(
      { runId: "run-1", threadId: "thread-1" },
      `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      activity,
      baselineRedactor,
    )).toMatchObject({
      provider: "t3",
      eventType: "approval.requested",
      payload: {
        id: "approval-1",
        sessionID: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
        requestKind: "command",
        detail: "git status",
      },
    });
    expect(runtimeActivityProviderEvent(
      { runId: "run-1", threadId: "thread-1" },
      `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      {
        ...activity,
        id: "activity-approval-resolved",
        kind: "approval.resolved",
        summary: "Approval resolved",
        payload: { requestId: "approval-1", decision: "accept" },
      },
      baselineRedactor,
    )).toMatchObject({
      eventType: "approval.resolved",
      payload: { requestId: "approval-1", decision: "accept" },
    });
  });

  test("builds a project rooted in the prepared sandbox workspace", () => {
    expect(
      buildRuntimeProjectCreateCommand(context, "/root/work"),
    ).toMatchObject({
      type: "project.create",
      commandId: `${SANDBOX_NAME_PREFIX}-project-create-run-unsafe`,
      title: "UseAgent thread unsafe",
      projectId: `${SANDBOX_NAME_PREFIX}-project-thread-unsafe`,
      workspaceRoot: "/root/work",
    });
  });

  test("projects streaming text, activities, completion, and errors", () => {
    const snapshot: RuntimeThreadSnapshot = {
      snapshotSequence: 8,
      thread: {
        id: "thread",
        latestTurn: { turnId: "turn", state: "completed", assistantMessageId: "assistant" },
        messages: [
          { id: "assistant", role: "assistant", text: "done", turnId: "turn", streaming: false },
        ],
        activities: [],
        session: { status: "ready", lastError: null },
      },
    };
    expect(assistantText(snapshot)).toBe("done");
    expect(runtimeTurnSettled(snapshot)).toBe(true);
    expect(runtimeTurnError(snapshot)).toBeNull();
    expect(
      activityStep({
        id: "activity",
        tone: "tool",
        kind: "tool.completed",
        summary: "Read package.json",
        payload: { path: "package.json" },
        turnId: "turn",
      }),
    ).toMatchObject({
      kind: "command",
      label: "Read package.json",
      chip: "tool.completed",
      code_json: { tool: "tool", error: false },
    });
    expect(activityStep({
      id: "file-change",
      tone: "tool",
      kind: "tool.completed",
      summary: "Changed app.ts",
      payload: { itemType: "file_change", data: { path: "app.ts" } },
      turnId: "turn",
    })).toMatchObject({ kind: "file", code_json: { tool: "edit" } });
    const mcpCompleted = {
      id: "mcp-completed",
      tone: "tool" as const,
      kind: "tool.completed",
      summary: `${LEGACY_TOOL_SERVER_IDS.gateway} · memory_search`,
      payload: {
        itemType: "mcp_tool_call",
        data: {
          item: {
            id: "exec-login-1",
            server: LEGACY_TOOL_SERVER_IDS.gateway,
            tool: "memory_search",
            arguments: { query: "release process" },
            result: { items: [] },
            status: "completed",
            type: "mcp_tool_call",
          },
        },
      },
      turnId: "turn",
    };
    expect(activityStep(mcpCompleted)).toMatchObject({
      kind: "command",
      label: "UseAgent · memory_search",
      code_json: {
        tool: "memory_search",
        server: LEGACY_TOOL_SERVER_IDS.gateway,
        input: { query: "release process" },
        native: { callID: "exec-login-1" },
      },
    });
    expect(runtimeActivityStepKey(mcpCompleted)).toBe("tool:exec-login-1");
    const agentStarted = {
      id: "subagent",
      tone: "info",
      kind: "task.started",
      summary: "Review auth",
      payload: { taskId: "task-1", agentKind: "agent", title: "Security review" },
      turnId: "turn",
    } as const;
    expect(activityStep(agentStarted)).toMatchObject({
      kind: "task",
      label: "Security review",
      chip: "subagent",
      code_json: {
        tool: "subagent",
        native: { sessionID: "task-1", callID: "task-1", childSessionID: "task-1" },
      },
    });
    expect(runtimeActivityStepKey(agentStarted)).toBe("task:task-1");
    expect(activityStep({
      id: "tool-started-child-lifecycle",
      tone: "info",
      kind: "task.started",
      summary: "Tool started",
      payload: {
        taskId: "google_price",
        agentKind: "agent",
        taskType: "tool",
        title: "Tool",
      },
      turnId: "turn",
    })).toMatchObject({
      kind: "task",
      label: "google price",
      chip: "subagent",
      code_json: {
        tool: "subagent",
        native: {
          sessionID: "google_price",
          callID: "google_price",
          childSessionID: "google_price",
        },
      },
    });
    const collabActivity = {
      id: "collab-completed",
      tone: "tool" as const,
      kind: "tool.completed",
      summary: "Calculate first product",
      payload: {
        itemType: "collab_agent_tool_call",
        detail: '<task id="ses_child" state="completed"><task_result>323</task_result></task>',
        data: { toolCallId: "call-1" },
      },
      turnId: "turn",
    };
    expect(activityStep(collabActivity)).toMatchObject({
      kind: "task",
      chip: "subagent",
      code_json: {
        tool: "subagent",
        native: { callID: "call-1", childSessionID: "ses_child" },
      },
    });
    expect(runtimeActivityStepKey(collabActivity)).toBe("tool:call-1");
    expect(shouldProjectRuntimeActivity(collabActivity)).toBe(true);
    expect(shouldProjectRuntimeActivity(collabActivity, [
      collabActivity,
      {
        id: "task-started",
        tone: "info",
        kind: "task.started",
        summary: "Child started",
        payload: {
          taskId: "ses_child",
          toolUseId: "call-1",
          agentKind: "agent",
        },
        turnId: "turn",
      },
    ])).toBe(false);
    expect(shouldProjectRuntimeActivity(collabActivity, [{
      id: "task-without-child-identity",
      tone: "info",
      kind: "task.started",
      summary: "Anonymous child",
      payload: { toolUseId: "call-1" },
      turnId: "turn",
    }])).toBe(true);
    expect(runtimeActivityStepKey({
      ...collabActivity,
      id: "collab-updated",
      kind: "tool.updated",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        data: { toolCallId: "call-1" },
      },
    })).toBe("tool:call-1");
    expect(shouldProjectRuntimeActivity({
      ...collabActivity,
      id: "read",
      payload: { itemType: "command_execution", data: { toolCallId: "read-1" } },
    })).toBe(true);
    expect(shouldProjectRuntimeActivity({
      ...collabActivity,
      id: "anonymous-start",
      kind: "tool.started",
      summary: "Tool started",
      payload: { itemType: "collab_agent_tool_call" },
    })).toBe(false);
    expect(shouldProjectRuntimeActivity({
      ...collabActivity,
      id: "identified-call-without-child",
      kind: "tool.started",
      payload: {
        itemType: "collab_agent_tool_call",
        toolCallId: "call-without-child",
        status: "inProgress",
        data: {},
      },
    })).toBe(false);
    expect(shouldProjectRuntimeActivity({
      ...collabActivity,
      id: "identified-child-start",
      kind: "tool.started",
      payload: {
        itemType: "collab_agent_tool_call",
        toolCallId: "call-with-child",
        childSessionId: "session-with-child",
        status: "inProgress",
      },
    })).toBe(true);
    const anonymousCompletion = {
      ...collabActivity,
      id: "anonymous-complete",
      summary: "Tool",
      payload: { itemType: "collab_agent_tool_call", data: {} },
    };
    expect(shouldProjectRuntimeActivity(anonymousCompletion)).toBe(true);
    expect(shouldProjectRuntimeActivity(anonymousCompletion, [{
      id: "authoritative-child",
      tone: "info",
      kind: "task.updated",
      summary: "calc_a",
      payload: {
        taskId: "ses_calc_a",
        agentKind: "agent",
        title: "calc_a",
        status: "idle",
      },
      turnId: "turn",
    }])).toBe(false);
    expect(shouldProjectRuntimeActivity({
      ...collabActivity,
      id: "anonymous-mcp-start",
      kind: "tool.started",
      summary: `${LEGACY_TOOL_SERVER_IDS.gateway} · computer_screenshot started`,
      payload: { itemType: "mcp_tool_call" },
    })).toBe(false);
    expect(shouldProjectRuntimeActivity({
      ...collabActivity,
      id: "generic-mcp-complete",
      kind: "tool.completed",
      summary: "Mcp tool call",
      payload: { itemType: "mcp_tool_call", callId: "opaque-1" },
    })).toBe(false);
    const summaryOnlyMcp = {
      ...collabActivity,
      id: "summary-only-mcp-complete",
      kind: "tool.completed",
      summary: `${LEGACY_TOOL_SERVER_IDS.gateway} · computer_screenshot started`,
      payload: { itemType: "mcp_tool_call", callId: "summary-only-1" },
    } as const;
    expect(shouldProjectRuntimeActivity(summaryOnlyMcp)).toBe(true);
    expect(activityStep(summaryOnlyMcp)).toMatchObject({
      label: "UseAgent · computer_screenshot",
      code_json: {
        server: LEGACY_TOOL_SERVER_IDS.gateway,
        tool: "computer_screenshot",
      },
    });
    expect(activityStep({
      ...collabActivity,
      id: "dynamic-complete",
      summary: `${LEGACY_TOOL_SERVER_IDS.gateway}_github_clone_repository`,
      payload: {
        itemType: "dynamic_tool_call",
        detail: "repository cloned",
        data: {
          server: LEGACY_TOOL_SERVER_IDS.gateway,
          toolName: "github_clone_repository",
          toolCallId: "clone-1",
        },
      },
    })).toMatchObject({
      label: "UseAgent · github_clone_repository",
      code_json: {
        server: LEGACY_TOOL_SERVER_IDS.gateway,
        tool: "github_clone_repository",
      },
    });
    expect(activityStep({
      ...collabActivity,
      id: "dynamic-sequence",
      summary: `${LEGACY_TOOL_SERVER_IDS.gateway}_computer_sequence`,
      payload: {
        itemType: "dynamic_tool_call",
        data: {
          server: LEGACY_TOOL_SERVER_IDS.gateway,
          toolName: "computer_sequence",
          toolCallId: "sequence-1",
          arguments: {
            actions: [
              { action: "hotkey", keys: "ctrl+l" },
              { action: "type", text: "https://example.com" },
              { action: "key", key: "ENTER" },
            ],
            screenshot: true,
          },
        },
      },
    })).toMatchObject({
      code_json: {
        server: LEGACY_TOOL_SERVER_IDS.gateway,
        tool: "computer_sequence",
        input: {
          actions: [{ action: "hotkey" }, { action: "type" }, { action: "key" }],
          screenshot: true,
        },
      },
    });
    expect(activityStep({
      ...collabActivity,
      id: "mcp-complete",
      summary: `${LEGACY_TOOL_SERVER_IDS.gateway} · computer_screenshot started`,
      payload: {
        itemType: "mcp_tool_call",
        tool: "mcp_tool_call",
        callId: "screenshot-1",
        data: {
          server: LEGACY_TOOL_SERVER_IDS.gateway,
          toolName: "computer_screenshot",
        },
      },
    })).toMatchObject({
      label: "UseAgent · computer_screenshot",
      code_json: {
        server: LEGACY_TOOL_SERVER_IDS.gateway,
        tool: "computer_screenshot",
        native: { callID: "screenshot-1" },
      },
    });
    const structuredMcpActivity = {
      ...collabActivity,
      id: "structured-mcp-identity",
      summary: "Create a pull request for the fix",
      payload: {
        itemType: "mcp_tool_call",
        data: {
          tool: "mcp_tool_call",
          toolCallId: "pr-1",
          item: {
            id: "pr-1",
            server: LEGACY_TOOL_SERVER_IDS.gateway,
            toolName: "github_create_pull_request",
            arguments: { title: "Fix MCP identity" },
            typedUsage: { inputTokens: 12, outputTokens: 3 },
          },
        },
      },
    } as const;
    expect(activityStep(structuredMcpActivity)).toMatchObject({
      label: "UseAgent · github_create_pull_request",
      code_json: {
        server: LEGACY_TOOL_SERVER_IDS.gateway,
        tool: "github_create_pull_request",
        input: { title: "Fix MCP identity" },
        native: {
          callID: "pr-1",
          activity: structuredMcpActivity.payload,
        },
      },
    });
    expect(shouldProjectRuntimeActivity(structuredMcpActivity)).toBe(true);
    expect(activityStep({
      ...collabActivity,
      id: "structured-mcp-no-server",
      summary: "Read the latest pricing page",
      payload: {
        itemType: "mcp_tool_call",
        data: {
          toolName: "webfetch",
          toolCallId: "webfetch-1",
          input: { url: "https://example.com/pricing" },
        },
      },
    })).toMatchObject({
      label: "webfetch",
      code_json: {
        tool: "webfetch",
        input: { url: "https://example.com/pricing" },
      },
    });
    expect(activityStep({
      ...collabActivity,
      id: "structured-child",
      payload: {
        itemType: "collab_agent_tool_call",
        childSessionId: "ses_structured_child",
        data: { toolCallId: "call-2" },
      },
    })).toMatchObject({
      code_json: {
        native: { callID: "call-2", childSessionID: "ses_structured_child" },
      },
    });
    expect(activityStep({
      id: "plan",
      tone: "info",
      kind: "turn.plan.updated",
      summary: "Plan updated",
      payload: { plan: [{ step: "Test the bridge", status: "inProgress" }] },
      turnId: "turn",
    })).toMatchObject({
      kind: "command",
      chip: "plan",
      code_json: {
        tool: "todowrite",
        input: { todos: [{ content: "Test the bridge", status: "in_progress" }] },
      },
    });
  });

  test("projects a successful structured MCP result without an error", () => {
    expect(activityStep({
      id: "mcp-success-result",
      tone: "tool",
      kind: "tool.completed",
      summary: `${LEGACY_TOOL_SERVER_IDS.gateway} · computer_sequence`,
      payload: {
        itemType: "mcp_tool_call",
        data: {
          item: {
            id: "call-success",
            server: LEGACY_TOOL_SERVER_IDS.gateway,
            toolName: "computer_sequence",
            result: {
              content: [{ type: "text", text: "completed" }],
              isError: false,
            },
          },
        },
      },
      turnId: "turn",
    })).toMatchObject({ code_json: { error: false } });
  });

  test("projects structured MCP isError and error results as errors", () => {
    const baseActivity = {
      id: "mcp-error-result",
      tone: "tool" as const,
      kind: "tool.completed",
      summary: `${LEGACY_TOOL_SERVER_IDS.gateway} · computer_sequence`,
      payload: {
        itemType: "mcp_tool_call",
        data: {
          item: {
            id: "call-error",
            server: LEGACY_TOOL_SERVER_IDS.gateway,
            toolName: "computer_sequence",
          },
        },
      },
      turnId: "turn",
    };
    expect(activityStep({
      ...baseActivity,
      payload: {
        ...baseActivity.payload,
        data: {
          item: {
            ...baseActivity.payload.data.item,
            result: { content: [{ type: "text", text: "invalid arguments" }], isError: true },
          },
        },
      },
    })).toMatchObject({ code_json: { error: true } });
    expect(activityStep({
      ...baseActivity,
      payload: {
        ...baseActivity.payload,
        data: {
          item: {
            ...baseActivity.payload.data.item,
            result: { error: { code: "invalid_arguments" } },
          },
        },
      },
    })).toMatchObject({ code_json: { error: true } });
  });

  test("projects slimmed stable MCP failure status as an error", () => {
    expect(activityStep({
      id: "mcp-slimmed-failure",
      tone: "tool",
      kind: "tool.completed",
      summary: "useagent · skills_list",
      payload: {
        itemType: "mcp_tool_call",
        status: "failed",
        data: {
          item: {
            id: "call-slimmed-failure",
            server: "useagent",
            tool: "skills_list",
            status: "failed",
            error: "upstream rejected the request",
            result: { content: "request failed" },
          },
        },
      },
      turnId: "turn",
    })).toMatchObject({ code_json: { error: true } });
  });

  test("projects only the latest turn's exact assistant output", () => {
    const exactOutput = `EXACT_${crypto.randomUUID()}`;
    const snapshot: RuntimeThreadSnapshot = {
      snapshotSequence: 12,
      thread: {
        id: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
        latestTurn: {
          turnId: "turn-2",
          state: "completed",
          assistantMessageId: "assistant-2",
        },
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "prior turn must not prefix the resumed answer",
            turnId: "turn-1",
            streaming: false,
          },
          {
            id: "assistant-2",
            role: "assistant",
            text: exactOutput,
            turnId: "turn-2",
            streaming: false,
          },
        ],
        activities: [],
        session: { status: "ready", lastError: null },
      },
    };

    expect(assistantText(snapshot)).toBe(exactOutput);
  });

  test("classifies an externally interrupted live turn as failed", () => {
    const snapshot = {
      snapshotSequence: 12,
      thread: {
        id: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
        latestTurn: {
          turnId: "turn-interrupted",
          state: "interrupted",
          assistantMessageId: null,
        },
        messages: [],
        activities: [],
        session: { status: "ready", lastError: null },
      },
    } satisfies RuntimeThreadSnapshot;

    expect(runtimeTurnSettled(snapshot)).toBe(true);
    expect(runtimeTurnError(snapshot)).toBe("The provider turn was interrupted");
  });

  test("never republishes a prior assistant answer while a resumed turn is starting", () => {
    const snapshot: RuntimeThreadSnapshot = {
      snapshotSequence: 13,
      thread: {
        id: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
        latestTurn: {
          turnId: "turn-2",
          state: "running",
          assistantMessageId: null,
        },
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "prior answer must not stream into this reply",
            turnId: "turn-1",
            streaming: false,
          },
        ],
        activities: [],
        session: { status: "ready", lastError: null },
      },
    };

    expect(assistantText(snapshot)).toBe("");

    expect(assistantText({
      ...snapshot,
      thread: {
        ...snapshot.thread,
        messages: [
          ...snapshot.thread.messages,
          {
            id: "assistant-2",
            role: "assistant",
            text: "current answer",
            turnId: "turn-2",
            streaming: true,
          },
        ],
      },
    })).toBe("current answer");
  });

  test("keeps resumed-turn provider events on the product thread and current run", () => {
    expect(runtimeActivityProviderEvent(
      { runId: "run-2", threadId: "thread-1" },
      `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      {
        id: "activity-resumed-turn",
        tone: "tool",
        kind: "tool.completed",
        summary: "Completed on the resumed provider thread",
        payload: { callId: "call-2" },
        turnId: "provider-turn-2",
      },
      baselineRedactor,
    )).toMatchObject({
      runId: "run-2",
      threadId: "thread-1",
      nativeSessionId: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      payload: { turnId: "provider-turn-2" },
    });
  });

  test("owns runtime child activity by explicit, nested, or root parent identity", () => {
    const codexChild = runtimeActivityProviderEvent(
      { runId: "run-child", threadId: "thread-1" },
      "root-native-session",
      {
        id: "child-status",
        tone: "info",
        kind: "task.updated",
        summary: "Researcher running",
        payload: {
          taskId: "child-native-session",
          agentKind: "agent",
          parentAgentId: "root-native-session",
          status: "running",
        },
        turnId: "turn-1",
      },
      baselineRedactor,
    );
    expect(codexChild).toMatchObject({
      nativeSessionId: "child-native-session",
      nativeParentSessionId: "root-native-session",
      nativeCallId: "child-native-session",
    });

    const claudeTopLevelChild = runtimeActivityProviderEvent(
      { runId: "run-child", threadId: "thread-1" },
      "root-native-session",
      {
        id: "child-status",
        tone: "info",
        kind: "task.updated",
        summary: "Researcher still running",
        payload: {
          taskId: "claude-child-session",
          agentKind: "agent",
          status: "running",
        },
        turnId: "turn-1",
      },
      baselineRedactor,
    );
    expect(claudeTopLevelChild).toMatchObject({
      nativeSessionId: "claude-child-session",
      nativeParentSessionId: "root-native-session",
      nativeCallId: "claude-child-session",
    });
    expect(activityStep({
      id: "top-level-child-status",
      tone: "info",
      kind: "task.updated",
      summary: "Researcher still running",
      payload: {
        taskId: "claude-child-session",
        agentKind: "agent",
        status: "running",
      },
      turnId: "turn-1",
    }, "root-native-session")).toMatchObject({
      code_json: {
        native: {
          sessionID: "claude-child-session",
          parentSessionID: "root-native-session",
        },
      },
    });

    const claudeNestedChild = runtimeActivityProviderEvent(
      { runId: "run-child", threadId: "thread-1" },
      "root-native-session",
      {
        id: "nested-child-status",
        tone: "info",
        kind: "task.updated",
        summary: "Nested researcher running",
        payload: {
          taskId: "claude-nested-child",
          agentId: "claude-child-session",
          agentKind: "agent",
          status: "running",
        },
        turnId: "turn-1",
      },
      baselineRedactor,
    );
    expect(claudeNestedChild).toMatchObject({
      nativeSessionId: "claude-nested-child",
      nativeParentSessionId: "claude-child-session",
      nativeCallId: "claude-nested-child",
    });
    expect(activityStep({
      id: "nested-child-status",
      tone: "info",
      kind: "task.updated",
      summary: "Nested researcher running",
      payload: {
        taskId: "claude-nested-child",
        agentId: "claude-child-session",
        agentKind: "agent",
        status: "running",
      },
      turnId: "turn-1",
    }, "root-native-session")).toMatchObject({
      code_json: {
        native: {
          sessionID: "claude-nested-child",
          parentSessionID: "claude-child-session",
        },
      },
    });

    const control = runtimeActivityProviderEvent(
      { runId: "run-child", threadId: "thread-1" },
      "root-native-session",
      {
        id: "wait-control",
        tone: "tool",
        kind: "tool.completed",
        summary: "Wait for agents",
        payload: {
          itemType: "collab_agent_tool_call",
          childSessionId: "child-native-session",
          delegationKind: "wait",
        },
        turnId: "turn-1",
      },
      baselineRedactor,
    );
    expect(control).toMatchObject({
      nativeSessionId: "root-native-session",
      nativeParentSessionId: null,
      payload: {
        payload: {
          childSessionId: "child-native-session",
          delegationKind: "wait",
        },
      },
    });

    const parentOwnedTask = runtimeActivityProviderEvent(
      { runId: "run-child", threadId: "thread-1" },
      "root-native-session",
      {
        id: "background-task",
        tone: "info",
        kind: "task.updated",
        summary: "Background shell running",
        payload: {
          taskId: "background-shell",
          agentId: "claude-child-session",
          agentKind: "background",
          status: "running",
        },
        turnId: "turn-1",
      },
      baselineRedactor,
    );
    expect(parentOwnedTask).toMatchObject({
      nativeSessionId: "root-native-session",
      nativeParentSessionId: null,
      nativeCallId: "background-shell",
    });
  });

  test("persists child parent identity in the task step compatibility projection", () => {
    expect(activityStep({
      id: "child-task",
      tone: "info",
      kind: "task.started",
      summary: "Researcher",
      payload: {
        taskId: "child-native-session",
        agentKind: "agent",
        parentAgentId: "root-native-session",
      },
      turnId: "turn-1",
    })).toMatchObject({
      code_json: {
        native: {
          sessionID: "child-native-session",
          parentSessionID: "root-native-session",
          childSessionID: "child-native-session",
        },
      },
    });
  });

  test("attributes T3 child transcript and tool activities without polluting the root", () => {
    const childMessageActivity = {
      id: "child-message:thread-1:child-1:message-1",
      tone: "info" as const,
      kind: "child.message.completed",
      summary: "Child response",
      payload: {
        agentId: "child-1",
        childSessionId: "child-1",
        parentAgentId: "root-native-session",
        messageId: "message-1",
        itemId: "message-1",
        streamKind: "assistant_text",
        text: "Child answer",
        status: "completed",
        revision: 3,
        timelineBypass: true,
      },
      turnId: "turn-1",
    };
    const childMessage = runtimeActivityProviderEvent(
      { runId: "run-child-message", threadId: "thread-1" },
      "root-native-session",
      childMessageActivity,
      baselineRedactor,
    );
    expect(childMessage).toMatchObject({
      nativeSessionId: "child-1",
      nativeParentSessionId: "root-native-session",
      nativeMessageId: "message-1",
      nativeCallId: null,
    });
    expect(shouldProjectRuntimeActivity(childMessageActivity)).toBe(false);
    expect(runtimeActivityProviderEvent(
      { runId: "run-child-message", threadId: "thread-1" },
      "root-native-session",
      {
        id: "child-message-without-parent",
        tone: "info",
        kind: "child.message.updated",
        summary: "Child response",
        payload: {
          agentId: "child-1",
          childSessionId: "child-1",
          messageId: "message-1",
          text: "Partial attribution",
          timelineBypass: true,
        },
        turnId: "turn-1",
      },
      baselineRedactor,
    )).toMatchObject({
      nativeSessionId: "child-1",
      nativeParentSessionId: "root-native-session",
    });

    const childToolActivity = {
      id: "child-tool-completed",
      tone: "tool" as const,
      kind: "tool.completed",
      summary: "Read completed",
      payload: {
        itemType: "dynamic_tool_call",
        agentId: "child-1",
        childSessionId: "child-1",
        parentAgentId: "root-native-session",
        timelineBypass: true,
        data: { item: { id: "tool-1", toolName: "read" } },
      },
      turnId: "turn-1",
    };
    expect(runtimeActivityProviderEvent(
      { runId: "run-child-message", threadId: "thread-1" },
      "root-native-session",
      childToolActivity,
      baselineRedactor,
    )).toMatchObject({
      nativeSessionId: "child-1",
      nativeParentSessionId: "root-native-session",
      nativeCallId: "tool-1",
    });
    expect(shouldProjectRuntimeActivity(childToolActivity)).toBe(false);
    expect(activityStep(childToolActivity, "root-native-session")).toMatchObject({
      code_json: {
        native: {
          sessionID: "child-1",
          parentSessionID: "root-native-session",
          callID: "tool-1",
        },
      },
    });
  });

  test("runtime child ownership reaches canonical projection exactly once", () => {
    const captured = runtimeActivityProviderEvent(
      { runId: "run-pipeline", threadId: "thread-pipeline" },
      "root-native-session",
      {
        id: "child-start",
        tone: "info",
        kind: "task.started",
        summary: "Researcher",
        payload: {
          taskId: "child-native-session",
          agentKind: "agent",
          parentAgentId: "root-native-session",
          status: "running",
        },
        turnId: "turn-1",
      },
      baselineRedactor,
    );
    const frame = makeNativeFrame({
      eventId: captured.id,
      seq: 0,
      provider: captured.provider,
      eventType: captured.eventType,
      sessionId: captured.nativeSessionId ?? null,
      parentSessionId: captured.nativeParentSessionId ?? null,
      messageId: captured.nativeMessageId ?? null,
      partId: captured.nativePartId ?? null,
      callId: captured.nativeCallId ?? null,
      payloadText: JSON.stringify(captured.payload),
    });
    const canonical = translateOpenCode([frame], {
      runId: "run-pipeline",
      threadId: "thread-pipeline",
      engine: "codex",
    }).events;

    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({
      kind: "child.started",
      childId: "child-native-session",
      identity: {
        nativeSessionId: "child-native-session",
        nativeParentSessionId: "root-native-session",
      },
    });
  });

  test("uses canonical tool-call identity precedence without losing the native payload", () => {
    const identityCases = [
      {
        name: "payload.toolCallId",
        activityId: "activity-payload-tool-call",
        payload: {
          toolCallId: "payload-call",
          data: { item: { id: "item-call" } },
        },
        expected: "payload-call",
      },
      {
        name: "data.toolCallId",
        activityId: "activity-data-tool-call",
        payload: {
          toolCallId: "payload-call",
          data: { toolCallId: "data-call", item: { id: "item-call" } },
        },
        expected: "data-call",
      },
      {
        name: "data.item.id",
        activityId: "activity-item-id",
        payload: {
          toolUseId: "tool-use-call",
          data: { item: { id: "item-call" } },
        },
        expected: "item-call",
      },
      {
        name: "activity id fallback",
        activityId: "fallback-activity",
        payload: { detail: "identity-free native activity" },
        expected: "fallback-activity",
      },
    ] as const;

    for (const identityCase of identityCases) {
      const identityActivity = {
        id: identityCase.activityId,
        tone: "tool" as const,
        kind: "tool.completed",
        summary: identityCase.name,
        payload: identityCase.payload,
        turnId: "turn",
      };
      const step = activityStep(identityActivity);
      expect(step).toMatchObject({
        code_json: { native: { callID: identityCase.expected } },
      });
      expect(runtimeActivityStepKey(identityActivity).split(":").at(-1)).toBe(
        identityCase.expected,
      );
      expect((step.code_json as {
        native: { activity: unknown };
      }).native.activity).toBe(identityCase.payload);
    }
  });

  test("does not expose transport placeholders as durable tool names", () => {
    for (const placeholder of ["task", "mcp tool call"]) {
      const step = activityStep({
        id: `activity-${placeholder}`,
        tone: "tool",
        kind: "tool.completed",
        summary: placeholder,
        payload: { data: { item: { id: `call-${placeholder}`, toolName: placeholder } } },
        turnId: "turn",
      });

      expect(step).toMatchObject({ code_json: { tool: "tool" } });
    }
  });

  test("distinguishes stable-id T3 activity revisions", () => {
    const base = {
      id: "task-progress:1",
      tone: "info" as const,
      kind: "task.progress",
      summary: "Working",
      payload: { taskId: "task-1", status: "running" },
      turnId: "turn-1",
    };
    expect(runtimeActivityRevision({ ...base, sequence: 7 })).toBe("7");
    expect(runtimeActivityRevision(base)).not.toBe(
      runtimeActivityRevision({ ...base, payload: { taskId: "task-1", status: "completed" } }),
    );
  });

  test("normalizes T3 user-input activities into the existing durable question lane", () => {
    const activity = {
      id: "activity-question",
      tone: "info" as const,
      kind: "user-input.requested",
      summary: "User input requested",
      payload: {
        requestId: "request-1",
        questions: [{
          id: "Framework?",
          header: "Framework",
          question: "Framework?",
          options: [{ label: "React", description: "React.js" }],
          multiSelect: false,
        }],
      },
      turnId: "turn-1",
    };
    expect(runtimeQuestionRequest(activity, `${SANDBOX_NAME_PREFIX}-thread-thread-1`)).toMatchObject({
      id: "request-1",
      sessionID: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      questions: [{ multiple: false, custom: true }],
    });
    expect(runtimeActivityProviderEvent(
      { runId: "run-1", threadId: "thread-1" },
      `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      activity,
      baselineRedactor,
    )).toMatchObject({
      provider: "t3",
      eventType: "question.asked",
      nativeSessionId: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
    });
  });

  test("redacts T3 activity before the provider-event persistence and SSE lane", () => {
    const secret = "SYNTHETIC_T3_ACTIVITY_SECRET_123456";
    const event = runtimeActivityProviderEvent(
      { runId: "run-secret", threadId: "thread-secret" },
      `${SANDBOX_NAME_PREFIX}-thread-thread-secret`,
      {
        id: "activity-secret",
        tone: "tool",
        kind: "tool.completed",
        summary: `Used ${secret}`,
        payload: {
          input: { token: secret },
          output: `provider returned ${secret}`,
        },
        turnId: "turn-secret",
      },
      createSecretRedactor([secret]),
    );

    expect(JSON.stringify(event.payload)).not.toContain(secret);
    expect(event.payload).toMatchObject({
      summary: "Used <redacted>",
      payload: {
        input: { token: "<redacted>" },
        output: "provider returned <redacted>",
      },
    });
  });

  test("redacts T3 question lifecycle answer keys and values while preserving request ids", () => {
    const secret = "SYNTHETIC_T3_QUESTION_LIFECYCLE_SECRET_123456";
    const event = runtimeActivityProviderEvent(
      { runId: "run-question", threadId: "thread-question" },
      `${SANDBOX_NAME_PREFIX}-thread-thread-question`,
      {
        id: "activity-question-resolved",
        tone: "info",
        kind: "user-input.resolved",
        summary: "User input submitted",
        payload: {
          requestId: "request-stable",
          answers: { [secret]: secret },
        },
        turnId: "turn-question",
      },
      createSecretRedactor([secret, "request-stable"]),
    );

    expect(event.payload).toEqual({
      requestID: "request-stable",
      requestId: "request-stable",
      answers: { "<redacted>": "<redacted>" },
    });
  });
});

describe("hasOpenRuntimeToolCall", () => {
  const tool = (kind: string, callId: string, tone: "tool" | "error" = "tool") => ({
    id: `${kind}-${callId}-${Math.abs(kind.length * 31 + callId.length)}`,
    tone,
    kind,
    summary: kind,
    payload: { toolCallId: callId },
    turnId: "turn-1",
  });

  test("an open tool call (started, no terminal) counts as in flight", () => {
    expect(hasOpenRuntimeToolCall([tool("tool.started", "call-1")])).toBe(true);
    expect(hasOpenRuntimeToolCall([
      tool("tool.started", "call-1"),
      tool("tool.updated", "call-1"),
    ])).toBe(true);
  });

  test("a completed or denied call is not in flight", () => {
    expect(hasOpenRuntimeToolCall([
      tool("tool.started", "call-1"),
      tool("tool.completed", "call-1"),
    ])).toBe(false);
    expect(hasOpenRuntimeToolCall([
      tool("tool.started", "call-1"),
      tool("tool.denied", "call-1"),
    ])).toBe(false);
  });

  test("an errored call does not hold the turn open", () => {
    expect(hasOpenRuntimeToolCall([
      tool("tool.started", "call-1"),
      tool("tool.updated", "call-1", "error"),
    ])).toBe(false);
  });

  test("one open call among settled ones keeps the turn in flight", () => {
    expect(hasOpenRuntimeToolCall([
      tool("tool.started", "call-1"),
      tool("tool.completed", "call-1"),
      tool("tool.started", "call-2"),
    ])).toBe(true);
    expect(hasOpenRuntimeToolCall([])).toBe(false);
  });
});

describe("activityStep file and command payloads", () => {
  const completed = (id: string, summary: string, payload: Record<string, unknown>) => ({
    id,
    tone: "tool" as const,
    kind: "tool.completed",
    summary,
    payload,
    turnId: "turn",
  });
  const stepFor = (engine: "codex" | "claude" | "opencode", id: string, payload: Record<string, unknown>) =>
    activityStep(completed(id, "Command run", { itemType: "command_execution", ...payload }), undefined, engine);

  test("a claude file change recovers its path from the detail string", () => {
    const step = activityStep(completed("fc-claude", "File change", {
      itemType: "file_change",
      toolName: "Write",
      detail: 'Write: {"file_path":"/w/src/app.ts","content":"export const a = 1;\\n"}',
      data: { toolCallId: "call-1", toolName: "Write" },
    }));
    expect(step.kind).toBe("file");
    expect(step.code_json).toMatchObject({
      input: { toolCallId: "call-1", file_path: "/w/src/app.ts", files: [{ path: "/w/src/app.ts" }] },
    });
  });

  test("a projected files list is kept whole and names its first path", () => {
    const step = activityStep(completed("fc-codex", "File change", {
      itemType: "file_change",
      detail: "apply_patch",
      data: { toolCallId: "call-2", files: [{ path: "a.ts" }, { path: "b.ts" }] },
    }));
    expect(step.code_json).toMatchObject({
      input: { file_path: "a.ts", files: [{ path: "a.ts" }, { path: "b.ts" }] },
    });
  });

  test("a path-less file change is passed through untouched", () => {
    const step = activityStep(completed("fc-none", "File change", {
      itemType: "file_change",
      detail: "Edit: [unserializable input]",
      data: { toolCallId: "call-3" },
    }));
    expect(step.code_json).toMatchObject({ input: { toolCallId: "call-3" } });
    expect((step.code_json as { input: Record<string, unknown> }).input.files).toBeUndefined();
  });

  test("a codex command reports its captured output and keeps the command line visible", () => {
    // The runtime keeps the command only under data.item; the UI reads input.command.
    const step = stepFor("codex", "cmd-codex", {
      detail: "printf hello",
      data: { toolCallId: "call-4", item: { command: "printf hello", aggregatedOutput: "hello" } },
    });
    expect(step.code_json).toMatchObject({
      input: { toolCallId: "call-4", command: "printf hello" },
      output: "hello",
    });
  });

  test("a command input that names its command is left alone", () => {
    const step = stepFor("codex", "cmd-named", {
      detail: "bun test",
      data: {
        toolCallId: "call-6",
        command: "bun test --filter x",
        item: { command: "bun test", result: { content: "1 pass" } },
      },
    });
    expect(step.code_json).toMatchObject({ input: { command: "bun test --filter x" }, output: "1 pass" });
  });

  test("a silent codex command never echoes its command line, however long", () => {
    const long = `cd /workspace/app && bun install --silent && bun run build && git add -A && git commit -q -m ${"x".repeat(160)} && git push -q origin HEAD`;
    for (const detail of ["true", `${long.slice(0, 177)}...`]) {
      const step = stepFor("codex", `cmd-silent-${detail.length}`, {
        detail,
        data: { toolCallId: "call-5", item: { command: detail === "true" ? "true" : long } },
      });
      expect((step.code_json as { output?: unknown }).output).toBeUndefined();
    }
  });

  test("a claude bash command reports the runtime's captured output", () => {
    const step = stepFor("claude", "cmd-claude", {
      toolName: "Bash",
      detail: "Bash: printf hello",
      data: { toolName: "Bash", command: "printf hello", rawOutput: { content: "hello" } },
    });
    expect(step.code_json).toMatchObject({ input: { command: "printf hello" }, output: "hello" });
  });

  test("a silent claude bash command never echoes its command line", () => {
    const step = stepFor("claude", "cmd-claude-silent", {
      toolName: "Bash",
      detail: `Bash: ${"y".repeat(200)}`,
      data: { toolName: "Bash", command: "y".repeat(400) },
    });
    expect((step.code_json as { output?: unknown }).output).toBeUndefined();
  });

  test("an opencode command keeps its detail, the real output, over the one-line summary", () => {
    const step = stepFor("opencode", "cmd-opencode", {
      detail: "line one\nline two\nline three",
      data: { command: "printf x", rawOutput: { content: "line one" } },
    });
    expect(step.code_json).toMatchObject({ output: "line one\nline two\nline three" });
  });

  test("an opencode command still running shows no output, its detail being the tool title", () => {
    const step = activityStep({
      id: "cmd-opencode-running",
      tone: "tool",
      kind: "tool.updated",
      summary: "Command run",
      payload: { itemType: "command_execution", detail: "Running bun test", data: { toolCallId: "call-11", command: "bun test" } },
      turnId: "turn",
    }, undefined, "opencode");
    expect((step.code_json as { output?: unknown }).output).toBeUndefined();
  });

  test("an unknown engine gets the captured text and nothing else", () => {
    const step = activityStep(completed("cmd-unknown", "Command run", {
      itemType: "command_execution",
      detail: "printf x",
      data: { command: "printf x", rawOutput: { content: "x" } },
    }));
    expect(step.code_json).toMatchObject({ output: "x" });
  });

  test("a claude notebook edit recovers its notebook path", () => {
    const step = activityStep(completed("fc-notebook", "File change", {
      itemType: "file_change",
      toolName: "NotebookEdit",
      detail: 'NotebookEdit: {"notebook_path":"/w/a.ipynb","cell_id":"3","new_source":"x"}',
      data: { toolCallId: "call-10", toolName: "NotebookEdit" },
    }));
    expect(step.code_json).toMatchObject({ input: { file_path: "/w/a.ipynb", files: [{ path: "/w/a.ipynb" }] } });
  });
});
