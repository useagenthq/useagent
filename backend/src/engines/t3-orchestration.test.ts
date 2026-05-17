import { describe, expect, test } from "bun:test";
import {
  activityStep,
  assistantText,
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
      "openrouter/openai/gpt-5.6-luna",
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
        model: "openrouter/openai/gpt-5.6-luna",
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
        model: "openrouter/openai/gpt-5.6-luna",
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
    expect(activityStep({
      ...collabActivity,
      id: "dynamic-complete",
      summary: "skynet-knowledge_github_clone_repository",
      payload: {
        itemType: "dynamic_tool_call",
        detail: "repository cloned",
        data: { toolCallId: "clone-1" },
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
      },
    })).toMatchObject({
      label: "skynet-knowledge · computer_screenshot",
      code_json: {
        server: "skynet-knowledge",
        tool: "computer_screenshot",
        native: { callID: "screenshot-1" },
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
