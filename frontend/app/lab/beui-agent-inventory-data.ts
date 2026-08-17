import { selectPendingApproval } from "@/components/chat/approval-state";
import { deriveCanonicalChildren } from "@/components/chat/canonical-children";
import type {
  CommandCatalogState,
  StoredCanonicalEvent,
} from "@/components/chat/canonical-timeline";
import { selectSessionCommandCatalog } from "@/components/chat/canonical-timeline";
import type { NativeFrame } from "@/components/chat/native-events";
import { selectPendingQuestion } from "@/components/chat/question-state";
import { selectableModelsForEngine } from "@/components/chat/types";
import { ACTIVITY_STEPS, CHILD_EVENTS, PLAN_ENTRIES } from "./agent-ui-showcase-data";

export const BEUI_AGENT_SOURCE_URL = "https://beui.dev/components/agents";
export const BEUI_AGENT_REGISTRY_URL = "https://beui.dev/r/chat-app.json";
export const BEUI_AGENT_LICENSE = "MIT";

export type BeuiDecision = "Reuse" | "Adapt" | "Reject";

export interface BeuiAgentRegistryItem {
  readonly slug: string;
  readonly label: string;
  readonly decision: BeuiDecision;
  readonly owner: string;
  readonly note: string;
  readonly sourceUrl?: string;
}

const PROMPT_SESSION_ID = "session_beui_inventory";
const PROMPT_RUN_ID = "run_beui_inventory";

const promptCatalogEvents: StoredCanonicalEvent[] = [
  {
    schemaVersion: 1,
    eventId: "beui-session-started",
    runId: PROMPT_RUN_ID,
    threadId: PROMPT_RUN_ID,
    kind: "session.started",
    seq: 1,
    deliverySeq: 1,
    revision: 0,
    identity: {
      nativeEventId: "beui-session-started",
      nativeSessionId: PROMPT_SESSION_ID,
    },
    capabilities: {
      modelSelection: true,
      uploads: true,
    },
  },
  {
    schemaVersion: 1,
    eventId: "beui-commands-updated",
    runId: PROMPT_RUN_ID,
    threadId: PROMPT_RUN_ID,
    kind: "commands.updated",
    seq: 2,
    deliverySeq: 2,
    revision: 0,
    identity: {
      nativeEventId: "beui-commands-updated",
      nativeSessionId: PROMPT_SESSION_ID,
    },
    catalog: [
      {
        name: "inspect",
        description: "Inspect the current slice without leaving the session.",
        input: "[files]",
      },
      {
        name: "verify",
        description: "Run the focused lab checks and report the result.",
        input: "[checks]",
      },
    ],
  },
];

const approvalFrame = (seq: number, eventType: string, payload: unknown): NativeFrame => ({
  schemaVersion: 1,
  eventId: `approval-${seq}`,
  seq,
  provider: "t3",
  eventType,
  native: {
    sessionId: "session_beui_inventory",
    parentSessionId: null,
    messageId: null,
    partId: null,
    callId: null,
  },
  payload,
});

const questionFrame = (seq: number, eventType: string, payload: unknown): NativeFrame => ({
  schemaVersion: 1,
  eventId: `question-${seq}`,
  seq,
  provider: "opencode",
  eventType,
  native: {
    sessionId: "session_beui_inventory",
    parentSessionId: null,
    messageId: null,
    partId: null,
    callId: null,
  },
  payload,
});

const approvalRequest = selectPendingApproval([
  approvalFrame(1, "approval.requested", {
    id: "approval-beui-1",
    sessionID: "session_beui_inventory",
    requestKind: "command",
    detail: "bun test frontend/components/agent-ui",
  }),
]);

const questionRequest = selectPendingQuestion([
  questionFrame(1, "question.asked", {
    id: "question-beui-1",
    sessionID: "session_beui_inventory",
    questions: [
      {
        header: "Inventory",
        question: "Which agent primitive should be promoted first?",
        options: [
          {
            label: "Prompt Input",
            description: "Surface the composer with commands and model state",
          },
          { label: "Question", description: "Surface the durable clarification card" },
        ],
        multiple: false,
        custom: true,
      },
    ],
  }),
]);

const promptCatalog = selectSessionCommandCatalog(
  [{ canonical: promptCatalogEvents }],
  PROMPT_SESSION_ID,
);

export const BEUI_PROMPT_COMMAND_STATE: CommandCatalogState = promptCatalog
  ? { status: "ready", commands: promptCatalog.commands, source: "opencode" }
  : { status: "unavailable", source: "opencode" };

export const BEUI_AGENT_INVENTORY: readonly BeuiAgentRegistryItem[] = [
  {
    slug: "prompt-input",
    label: "Prompt Input",
    decision: "Reuse",
    owner: "components/chat/composer.tsx",
    note: "Reuse the production composer so the lab mirrors the live session input, not a second chat shell.",
    sourceUrl: "https://beui.dev/components/agents/prompt-input",
  },
  {
    slug: "agent-activity",
    label: "Agent Activity",
    decision: "Adapt",
    owner: "components/chat/canonical-timeline.ts",
    note: "Group canonical tool work into phase boundaries and keep tool rows in the shared trace grammar.",
    sourceUrl: "https://beui.dev/components/agents/agent-activity",
  },
  {
    slug: "todo-list",
    label: "Todo List",
    decision: "Reuse",
    owner: "components/agent-ui/plan-checklist.tsx",
    note: "Plan state comes from the durable task model; completion is shown as progress, not a guessed trace.",
    sourceUrl: "https://beui.dev/components/agents/todo-list",
  },
  {
    slug: "approval-card",
    label: "Approval Card",
    decision: "Reuse",
    owner: "components/chat/native-approval-card.tsx",
    note: "Keep the human-in-the-loop approval state machine durable and session-scoped.",
    sourceUrl: "https://beui.dev/components/agents/approval-card",
  },
  {
    slug: "question",
    label: "Question",
    decision: "Reuse",
    owner: "components/chat/question-card.tsx",
    note: "Promote the durable clarification card alongside approvals so the lab covers both interruptions.",
  },
  {
    slug: "tool-result",
    label: "Tool Result",
    decision: "Adapt",
    owner: "components/agent-ui/rich-tool-result.tsx",
    note: "Show tool output as a bounded disclosure with code, preview, and completion state.",
    sourceUrl: "https://beui.dev/components/agents/tool-result",
  },
  {
    slug: "file-diff",
    label: "File Diff",
    decision: "Adapt",
    owner: "components/agent-ui/code-diff.tsx",
    note: "Pair code and diff rows instead of a free-form transcript so review remains inspectable.",
    sourceUrl: "https://beui.dev/components/agents/file-diff",
  },
  {
    slug: "subagents",
    label: "Subagents",
    decision: "Reuse",
    owner: "components/agent-ui/live-subagent-status.tsx",
    note: "Rehydrate child-session state from the canonical child lifecycle model.",
    sourceUrl: "https://beui.dev/components/agents/agent-loading-states",
  },
] as const;

export const BEUI_REJECTED_SURFACES: readonly BeuiAgentRegistryItem[] = [
  {
    slug: "chat-app",
    label: "Chat App",
    decision: "Reject",
    owner: "production shell",
    note: "Would duplicate the session workspace and create a second chat shell.",
    sourceUrl: "https://beui.dev/components/agents",
  },
  {
    slug: "message-scroller",
    label: "Message Scroller",
    decision: "Reject",
    owner: "production shell",
    note: "The live transcript already owns reader-aware scrolling and follow-output behavior.",
    sourceUrl: "https://beui.dev/components/agents",
  },
  {
    slug: "ai-sidebar",
    label: "AI Sidebar",
    decision: "Reject",
    owner: "shell/sidebar",
    note: "Would fork the existing sidebar contract; the lab must not add a second navigation rail.",
    sourceUrl: "https://beui.dev/components/agents",
  },
] as const;

export const BEUI_PROMPT_INPUT = {
  commandState: BEUI_PROMPT_COMMAND_STATE,
  defaultEngine: "opencode" as const,
  defaultMemoryScope: "org" as const,
  defaultModel: selectableModelsForEngine("opencode")[0]?.value ?? "openai/gpt-5.6-luna",
} as const;

export const BEUI_ACTIVITY_GROUPS = [
  {
    id: "understand",
    label: "Understand the contract",
    description: "Read the canonical event vocabulary before composing the UI.",
    status: "completed" as const,
    steps: ACTIVITY_STEPS.slice(0, 1),
  },
  {
    id: "verify",
    label: "Verify the primitive set",
    description: "Confirm the live fixtures come from the same reducers as production.",
    status: "running" as const,
    steps: ACTIVITY_STEPS.slice(1),
  },
] as const;

export const BEUI_CHILD_MODEL = deriveCanonicalChildren(CHILD_EVENTS);

export const BEUI_PLAN_ENTRIES = PLAN_ENTRIES;

export const BEUI_APPROVAL_REQUEST = approvalRequest;
export const BEUI_QUESTION_REQUEST = questionRequest;
