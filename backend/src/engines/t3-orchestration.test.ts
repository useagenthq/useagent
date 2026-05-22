import { describe, expect, test } from "bun:test";
import {
  activityStep,
  assistantText,
  hasOpenT3ToolCall,
  buildT3ProjectCreateCommand,
  buildT3ThreadCreateCommand,
  buildT3TurnStartCommand,
  t3ActivityProviderEvent,
  t3ActivityRevision,
  t3ActivityStepKey,
  shouldProjectT3Activity,
  t3ModelId,
  t3QuestionRequest,
  t3ProjectId,
  t3ThreadId,
  t3TurnError,
  t3TurnSettled,
  type T3ThreadSnapshot,
} from "./t3-orchestration";

const context = { runId: "run/unsafe", threadId: "thread unsafe", model: "gpt-5.6-luna" };

describe("T3 orchestration projection", () => {
  test("derives stable transport-safe project and thread ids", () => {
    expect(t3ProjectId(context)).toBe("skynet-project-thread-unsafe");
    expect(t3ThreadId(context)).toBe("skynet-thread-thread-unsafe");
  });

  test("builds a first-turn bootstrap using the selected provider instance", () => {
    const command = buildT3TurnStartCommand(
      context,
      "codex",
      "use every prompt without keyword routing",
      "2026-08-12T00:00:00.000Z",
      true,
    );
    expect(command.type).toBe("thread.turn.start");
    expect(command.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-luna",
      options: [],
    });
    expect(command.bootstrap).toBeDefined();
    expect(command.runtimeMode).toBe("full-access");
    expect((command.message as { text: string }).text).toBe(
      "use every prompt without keyword routing",
    );
  });

  test("builds an explicit thread before HTTP turn dispatch", () => {
    expect(
      buildT3ThreadCreateCommand(
        { runId: "run-1", threadId: "thread-1", model: "gpt-5.6-luna" },
        "codex",
        "2026-08-12T00:00:00.000Z",
      ),
    ).toMatchObject({
      type: "thread.create",
      threadId: "skynet-thread-thread-1",
      projectId: "skynet-project-thread-1",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
      runtimeMode: "full-access",
    });
  });

  test("maps Skynet OpenCode catalog ids onto T3 provider-qualified ids", () => {
    expect(t3ModelId("opencode", "openai/gpt-5.6-luna")).toBe(
      "openai/gpt-5.6-luna",
    );
    expect(t3ModelId("opencode", "moonshotai/kimi-k3")).toBe(
      "openrouter/moonshotai/kimi-k3",
    );
    expect(t3ModelId("opencode", "claude-opus-5")).toBe(
      "anthropic/claude-opus-5",
    );
    expect(t3ModelId("opencode", "openrouter/openai/gpt-5.6-luna")).toBe(
      "openrouter/openai/gpt-5.6-luna",
    );
    expect(t3ModelId("codex", "gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });

  test("uses provider-qualified OpenCode ids for thread and turn commands", () => {
    const opencodeContext = {
      runId: "run-opencode",
      threadId: "thread-opencode",
      model: "openai/gpt-5.6-luna",
    };
    expect(
      buildT3ThreadCreateCommand(
        opencodeContext,
        "opencode",
        "2026-08-12T00:00:00.000Z",
      ),
    ).toMatchObject({
      modelSelection: {
        instanceId: "opencode",
        model: "openai/gpt-5.6-luna",
      },
    });
    expect(
      buildT3TurnStartCommand(
        opencodeContext,
        "opencode",
        "test",
        "2026-08-12T00:00:00.000Z",
        false,
      ),
    ).toMatchObject({
      modelSelection: {
        instanceId: "opencode",
        model: "openai/gpt-5.6-luna",
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
    expect(t3ActivityProviderEvent(
      { runId: "run-1", threadId: "thread-1" },
      "skynet-thread-thread-1",
      activity,
    )).toMatchObject({
      provider: "t3",
      eventType: "approval.requested",
      payload: {
        id: "approval-1",
        sessionID: "skynet-thread-thread-1",
        requestKind: "command",
        detail: "git status",
      },
    });
    expect(t3ActivityProviderEvent(
      { runId: "run-1", threadId: "thread-1" },
      "skynet-thread-thread-1",
      {
        ...activity,
        id: "activity-approval-resolved",
        kind: "approval.resolved",
        summary: "Approval resolved",
        payload: { requestId: "approval-1", decision: "accept" },
      },
    )).toMatchObject({
      eventType: "approval.resolved",
      payload: { requestId: "approval-1", decision: "accept" },
    });
  });

  test("builds a project rooted in the prepared sandbox workspace", () => {
    expect(
      buildT3ProjectCreateCommand(context, "/root/work", "2026-08-12T00:00:00.000Z"),
    ).toMatchObject({
      type: "project.create",
      projectId: "skynet-project-thread-unsafe",
      workspaceRoot: "/root/work",
    });
  });

  test("projects streaming text, activities, completion, and errors", () => {
    const snapshot: T3ThreadSnapshot = {
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
    expect(t3TurnSettled(snapshot)).toBe(true);
    expect(t3TurnError(snapshot)).toBeNull();
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
      summary: "skynet-knowledge · loop_login_open",
      payload: {
        itemType: "mcp_tool_call",
        data: {
          item: {
            id: "exec-login-1",
            server: "skynet-knowledge",
            tool: "loop_login_open",
            arguments: { org: "overwatch" },
            result: { opened: true },
            status: "completed",
            type: "mcp_tool_call",
          },
        },
      },
      turnId: "turn",
    };
    expect(activityStep(mcpCompleted)).toMatchObject({
      kind: "command",
      label: "skynet-knowledge · loop_login_open",
      code_json: {
        tool: "loop_login_open",
        server: "skynet-knowledge",
        input: { org: "overwatch" },
        native: { callID: "exec-login-1" },
      },
    });
    expect(t3ActivityStepKey(mcpCompleted)).toBe("tool:exec-login-1");
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
    expect(t3ActivityStepKey(agentStarted)).toBe("task:task-1");
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
    expect(t3ActivityStepKey(collabActivity)).toBe("tool:call-1");
    expect(shouldProjectT3Activity(collabActivity)).toBe(true);
    expect(shouldProjectT3Activity(collabActivity, [
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
    expect(shouldProjectT3Activity(collabActivity, [{
      id: "task-without-child-identity",
      tone: "info",
      kind: "task.started",
      summary: "Anonymous child",
      payload: { toolUseId: "call-1" },
      turnId: "turn",
    }])).toBe(true);
    expect(t3ActivityStepKey({
      ...collabActivity,
      id: "collab-updated",
      kind: "tool.updated",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        data: { toolCallId: "call-1" },
      },
    })).toBe("tool:call-1");
    expect(shouldProjectT3Activity({
      ...collabActivity,
      id: "read",
      payload: { itemType: "command_execution", data: { toolCallId: "read-1" } },
    })).toBe(true);
    expect(shouldProjectT3Activity({
      ...collabActivity,
      id: "anonymous-start",
      kind: "tool.started",
      summary: "Tool started",
      payload: { itemType: "collab_agent_tool_call" },
    })).toBe(false);
    const anonymousCompletion = {
      ...collabActivity,
      id: "anonymous-complete",
      summary: "Tool",
      payload: { itemType: "collab_agent_tool_call", data: {} },
    };
    expect(shouldProjectT3Activity(anonymousCompletion)).toBe(true);
    expect(shouldProjectT3Activity(anonymousCompletion, [{
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
    expect(shouldProjectT3Activity({
      ...collabActivity,
      id: "anonymous-mcp-start",
      kind: "tool.started",
      summary: "skynet-knowledge · computer_screenshot started",
      payload: { itemType: "mcp_tool_call" },
    })).toBe(false);
    expect(shouldProjectT3Activity({
      ...collabActivity,
      id: "generic-mcp-complete",
      kind: "tool.completed",
      summary: "Mcp tool call",
      payload: { itemType: "mcp_tool_call", callId: "opaque-1" },
    })).toBe(false);
    expect(shouldProjectT3Activity({
      ...collabActivity,
      id: "summary-only-mcp-complete",
      kind: "tool.completed",
      summary: "skynet-knowledge · computer_screenshot started",
      payload: { itemType: "mcp_tool_call", callId: "summary-only-1" },
    })).toBe(false);
    expect(activityStep({
      ...collabActivity,
      id: "dynamic-complete",
      summary: "skynet-knowledge_github_clone_repository",
      payload: {
        itemType: "dynamic_tool_call",
        detail: "repository cloned",
        data: {
          server: "skynet-knowledge",
          toolName: "github_clone_repository",
          toolCallId: "clone-1",
        },
      },
    })).toMatchObject({
      label: "skynet-knowledge · github_clone_repository",
      code_json: {
        server: "skynet-knowledge",
        tool: "github_clone_repository",
      },
    });
    expect(activityStep({
      ...collabActivity,
      id: "dynamic-sequence",
      summary: "skynet-knowledge_computer_sequence",
      payload: {
        itemType: "dynamic_tool_call",
        data: {
          server: "skynet-knowledge",
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
        server: "skynet-knowledge",
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
      summary: "skynet-knowledge · computer_screenshot started",
      payload: {
        itemType: "mcp_tool_call",
        tool: "mcp_tool_call",
        callId: "screenshot-1",
        data: {
          server: "skynet-knowledge",
          toolName: "computer_screenshot",
        },
      },
    })).toMatchObject({
      label: "skynet-knowledge · computer_screenshot",
      code_json: {
        server: "skynet-knowledge",
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
            server: "skynet-knowledge",
            toolName: "github_create_pull_request",
            arguments: { title: "Fix MCP identity" },
            typedUsage: { inputTokens: 12, outputTokens: 3 },
          },
        },
      },
    } as const;
    expect(activityStep(structuredMcpActivity)).toMatchObject({
      label: "skynet-knowledge · github_create_pull_request",
      code_json: {
        server: "skynet-knowledge",
        tool: "github_create_pull_request",
        input: { title: "Fix MCP identity" },
        native: {
          callID: "pr-1",
          activity: structuredMcpActivity.payload,
        },
      },
    });
    expect(shouldProjectT3Activity(structuredMcpActivity)).toBe(true);
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

  test("projects only the latest turn's exact assistant output", () => {
    const exactOutput = `EXACT_${crypto.randomUUID()}`;
    const snapshot: T3ThreadSnapshot = {
      snapshotSequence: 12,
      thread: {
        id: "skynet-thread-thread-1",
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

  test("keeps resumed-turn provider events on the product thread and current run", () => {
    expect(t3ActivityProviderEvent(
      { runId: "run-2", threadId: "thread-1" },
      "skynet-thread-thread-1",
      {
        id: "activity-resumed-turn",
        tone: "tool",
        kind: "tool.completed",
        summary: "Completed on the resumed provider thread",
        payload: { callId: "call-2" },
        turnId: "provider-turn-2",
      },
    )).toMatchObject({
      runId: "run-2",
      threadId: "thread-1",
      nativeSessionId: "skynet-thread-thread-1",
      payload: { turnId: "provider-turn-2" },
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
      expect(t3ActivityStepKey(identityActivity).split(":").at(-1)).toBe(
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
    expect(t3ActivityRevision({ ...base, sequence: 7 })).toBe("7");
    expect(t3ActivityRevision(base)).not.toBe(
      t3ActivityRevision({ ...base, payload: { taskId: "task-1", status: "completed" } }),
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
    expect(t3QuestionRequest(activity, "skynet-thread-thread-1")).toMatchObject({
      id: "request-1",
      sessionID: "skynet-thread-thread-1",
      questions: [{ multiple: false, custom: true }],
    });
    expect(t3ActivityProviderEvent(
      { runId: "run-1", threadId: "thread-1" },
      "skynet-thread-thread-1",
      activity,
    )).toMatchObject({
      provider: "t3",
      eventType: "question.asked",
      nativeSessionId: "skynet-thread-thread-1",
    });
  });
});

describe("hasOpenT3ToolCall", () => {
  const tool = (kind: string, callId: string, tone: "tool" | "error" = "tool") => ({
    id: `${kind}-${callId}-${Math.abs(kind.length * 31 + callId.length)}`,
    tone,
    kind,
    summary: kind,
    payload: { toolCallId: callId },
    turnId: "turn-1",
  });

  test("an open tool call (started, no terminal) counts as in flight", () => {
    expect(hasOpenT3ToolCall([tool("tool.started", "call-1")])).toBe(true);
    expect(hasOpenT3ToolCall([
      tool("tool.started", "call-1"),
      tool("tool.updated", "call-1"),
    ])).toBe(true);
  });

  test("a completed or denied call is not in flight", () => {
    expect(hasOpenT3ToolCall([
      tool("tool.started", "call-1"),
      tool("tool.completed", "call-1"),
    ])).toBe(false);
    expect(hasOpenT3ToolCall([
      tool("tool.started", "call-1"),
      tool("tool.denied", "call-1"),
    ])).toBe(false);
  });

  test("an errored call does not hold the turn open", () => {
    expect(hasOpenT3ToolCall([
      tool("tool.started", "call-1"),
      tool("tool.updated", "call-1", "error"),
    ])).toBe(false);
  });

  test("one open call among settled ones keeps the turn in flight", () => {
    expect(hasOpenT3ToolCall([
      tool("tool.started", "call-1"),
      tool("tool.completed", "call-1"),
      tool("tool.started", "call-2"),
    ])).toBe(true);
    expect(hasOpenT3ToolCall([])).toBe(false);
  });
});
