import { describe, expect, test } from "bun:test";
import {
  attribute,
  childSessionOf,
  deriveSubagents,
  nativeOf,
  type SubagentCard,
} from "./subagents";
import type { ApiStep } from "./types";

// Fixtures mirror the real captured shapes (run fdc7c3f3): a 2× concurrent fanout
// where the primary agent spawns two `task`-tool subagents whose child session id
// only appears inside the tool output `<task id="ses_…">`, and each child's own
// write lands as a "↳ "-labelled file step stamped with that child `sessionID`.
const ROOT = "ses_root";
const CHILD_A = "ses_childA";
const CHILD_B = "ses_childB";

let seq = 0;
function step(partial: Partial<ApiStep> & Pick<ApiStep, "kind" | "label">): ApiStep {
  const idx = seq++;
  return {
    id: partial.id ?? `step-${idx}`,
    run_id: "run-1",
    idx,
    chip: partial.chip ?? null,
    code_json: partial.code_json ?? null,
    created_at: partial.created_at ?? new Date(1_700_000_000_000 + idx * 1000).toISOString(),
    ...partial,
  };
}

function taskCard(id: string, description: string, childSession: string): ApiStep {
  return step({
    id,
    kind: "task",
    chip: "subagent",
    label: `Subagent — ${description}`,
    code_json: JSON.stringify({
      tool: "task",
      input: { description },
      output: `<task id="${childSession}" state="completed">\n<task_result>\nok\n</task_result>\n</task>`,
      native: { sessionID: ROOT, messageID: "m", partID: "p", callID: "c" },
    }),
  });
}

function childWrite(id: string, file: string, childSession: string): ApiStep {
  return step({
    id,
    kind: "file",
    chip: "file",
    label: `↳ ${file}`,
    code_json: JSON.stringify({
      tool: "write",
      input: { filePath: `/tmp/${file}`, content: "x" },
      output: "Wrote file successfully.",
      native: { sessionID: childSession, messageID: "m", partID: "p", callID: "c" },
    }),
  });
}

function rootRead(id: string, file: string): ApiStep {
  return step({
    id,
    kind: "command",
    chip: "read",
    label: "read",
    code_json: JSON.stringify({
      tool: "read",
      input: { filePath: `/tmp/${file}` },
      output: `1: x`,
      native: { sessionID: ROOT, messageID: "m", partID: "p", callID: "c" },
    }),
  });
}

function nativeFanout(): ApiStep[] {
  seq = 0;
  return [
    taskCard("cardA", "Write DELTA to /tmp/p1.txt", CHILD_A),
    taskCard("cardB", "Write DELTA2 to /tmp/p2.txt", CHILD_B),
    childWrite("nestA", "p1.txt", CHILD_A),
    childWrite("nestB", "p2.txt", CHILD_B),
    rootRead("readA", "p1.txt"),
    rootRead("readB", "p2.txt"),
  ];
}

describe("childSessionOf", () => {
  test("parses the child session id out of the task-tool output XML", () => {
    const [cardA] = nativeFanout();
    expect(childSessionOf(cardA)).toBe(CHILD_A);
  });

  test("prefers an explicit native.childSessionID (subtask path)", () => {
    const subtask = step({
      kind: "task",
      chip: "subagent",
      label: "Subagent — sub",
      code_json: JSON.stringify({ native: { sessionID: ROOT, childSessionID: CHILD_B } }),
    });
    expect(childSessionOf(subtask)).toBe(CHILD_B);
  });

  test("returns null when the child id is not yet discoverable", () => {
    const running = step({
      kind: "task",
      chip: "subagent",
      label: "Subagent — running",
      code_json: JSON.stringify({ tool: "task", input: { description: "x" }, native: { sessionID: ROOT } }),
    });
    expect(childSessionOf(running)).toBeNull();
  });
});

describe("nativeOf", () => {
  test("reads stamped ids", () => {
    const [, , nestA] = nativeFanout();
    expect(nativeOf(nestA)?.sessionID).toBe(CHILD_A);
  });

  test("is null for pre-stamp steps (no code_json)", () => {
    expect(nativeOf(step({ kind: "file", chip: "file", label: "↳ legacy" }))).toBeNull();
  });
});

describe("deriveSubagents — native attribution", () => {
  const { cards, ownerByStep } = deriveSubagents(nativeFanout());
  const byId = new Map(cards.map((c) => [c.id, c] as const));

  test("derives one card per spawn with its child session + task-tool call id", () => {
    expect(cards.map((c) => c.id)).toEqual(["cardA", "cardB"]);
    expect(byId.get("cardA")?.childSessionId).toBe(CHILD_A);
    expect(byId.get("cardB")?.childSessionId).toBe(CHILD_B);
    // callId links a card to its native status frame (deriveChildFidelity).
    expect(byId.get("cardA")?.callId).toBe("c");
  });

  test("attributes each nested step to the card whose child session it ran in", () => {
    // The crux: p1 under DELTA (cardA), p2 under DELTA2 (cardB). The old
    // spawn-order heuristic put BOTH under the newest card (cardB).
    expect(ownerByStep.get("nestA")).toBe("cardA");
    expect(ownerByStep.get("nestB")).toBe("cardB");
  });

  test("each card's status reflects only its own child's activity", () => {
    expect(byId.get("cardA")?.status).toBe("p1.txt");
    expect(byId.get("cardB")?.status).toBe("p2.txt");
  });

  test("parent-session steps attribute to no subagent", () => {
    expect(ownerByStep.has("readA")).toBe(false);
    expect(ownerByStep.has("readB")).toBe(false);
  });

  test("ignores T3 task lifecycle rows that were incorrectly chipped as subagents", () => {
    const badLifecycleRow = step({
      id: "google_price_started",
      kind: "task",
      chip: "subagent",
      label: "Tool started",
      code_json: JSON.stringify({
        source: "t3",
        activityKind: "task.started",
        tool: "task",
        input: { description: "Tool" },
        native: { callID: "google_price" },
      }),
    });
    const realSpawn = step({
      id: "google_price_spawn",
      kind: "task",
      chip: "subagent",
      label: "Find Google price",
      code_json: JSON.stringify({
        source: "t3",
        activityKind: "tool.completed",
        tool: "subagent",
        input: { toolCallId: "google_price" },
        output: '<task id="agent-google" state="completed"><task_result>GOOG 123</task_result></task>',
        native: { callID: "google_price", childSessionID: "agent-google" },
      }),
    });

    const model = deriveSubagents([badLifecycleRow, realSpawn]);

    expect(model.cards.map((card) => card.id)).toEqual(["google_price_spawn"]);
    expect(model.cards[0]?.childSessionId).toBe("agent-google");
  });
});

describe("attribute — discriminated outcomes", () => {
  const cards: SubagentCard[] = [];
  const byChildSession = new Map<string, SubagentCard>();
  const byCallId = new Map<string, SubagentCard>();
  for (const s of nativeFanout()) {
    if (s.chip === "subagent") {
      const childSessionId = childSessionOf(s);
      const callId = nativeOf(s)?.callID ?? null;
      const aliases = [...new Set([callId, childSessionId].filter((id): id is string => !!id))];
      const card: SubagentCard = {
        id: s.id,
        title: s.label,
        childSessionId,
        callId,
        aliases,
        status: null,
        startedAt: 0,
        lastActivityAt: null,
      };
      cards.push(card);
      if (card.childSessionId) byChildSession.set(card.childSessionId, card);
      for (const alias of card.aliases) byCallId.set(alias, card);
    }
  }

  test("native child-session match → kind 'native'", () => {
    const r = attribute(childWrite("x", "p1.txt", CHILD_A), byChildSession, byCallId, cards);
    expect(r.kind).toBe("native");
    if (r.kind === "native") expect(r.card.id).toBe("cardA");
  });

  test("a native step with an unknown session is left unattributed, not guessed", () => {
    const grandchild = childWrite("gc", "deep.txt", "ses_grandchild");
    expect(attribute(grandchild, byChildSession, byCallId, cards).kind).toBe("none");
  });

  test("a native step on the root session is not nested", () => {
    expect(attribute(rootRead("r", "p1.txt"), byChildSession, byCallId, cards).kind).toBe("none");
  });
});

describe("deriveSubagents — legacy fallback (pre-stamp, no native ids)", () => {
  seq = 0;
  const legacy: ApiStep[] = [
    step({ id: "L1", kind: "task", chip: "subagent", label: "Subagent — Legacy A" }),
    step({ id: "L2", kind: "task", chip: "subagent", label: "Subagent — Legacy B" }),
    step({ id: "Ln", kind: "file", chip: "file", label: "↳ wrote thing" }),
  ];
  const { cards, ownerByStep } = deriveSubagents(legacy);

  test("still derives cards and does not throw", () => {
    expect(cards.map((c) => c.id)).toEqual(["L1", "L2"]);
    expect(cards.every((c) => c.childSessionId === null)).toBe(true);
  });

  test("↳ step attributes to the most-recently-spawned card", () => {
    expect(ownerByStep.get("Ln")).toBe("L2");
    expect(attribute(legacy[2], new Map(), new Map(), cards).kind).toBe("legacy");
  });
});

describe("deriveSubagents — anonymous tool calls are not agents", () => {
  // The prod regression: a runtime `collab_agent_tool_call` row that the adapter
  // chips `subagent` with tool "subagent" but that resolves NO child session and
  // names NO real objective - its label falls back to "Tool". Carding it produced
  // the NINE identical "Tool" cards. It must be excluded from the rail entirely.
  const anonymousToolRow = (id: string): ApiStep =>
    step({
      id,
      kind: "task",
      chip: "subagent",
      label: "Tool",
      code_json: JSON.stringify({
        source: "t3",
        activityKind: "tool.completed",
        tool: "subagent",
        input: {},
        native: { callID: `${id}-call` },
      }),
    });

  test("excludes subagent-chipped rows with no child session and no objective", () => {
    seq = 0;
    const model = deriveSubagents([
      anonymousToolRow("a1"),
      anonymousToolRow("a2"),
      anonymousToolRow("a3"),
    ]);
    expect(model.cards).toEqual([]);
  });

  test("keeps a real spawn that resolves a child session, even with a bare label", () => {
    seq = 0;
    const withChild = step({
      id: "real-child",
      kind: "task",
      chip: "subagent",
      label: "Tool",
      code_json: JSON.stringify({
        tool: "subagent",
        input: {},
        native: { callID: "c", childSessionID: "ses_real" },
      }),
    });
    const model = deriveSubagents([withChild]);
    expect(model.cards.map((c) => c.id)).toEqual(["real-child"]);
    expect(model.cards[0]?.childSessionId).toBe("ses_real");
    // A real child that only had a placeholder label reads "Subagent", never "Tool".
    expect(model.cards[0]?.title).toBe("Subagent");
  });

  test("keeps a real spawn that names a real objective without a child id yet", () => {
    seq = 0;
    const withObjective = step({
      id: "objective-only",
      kind: "task",
      chip: "subagent",
      label: "Subagent — Get Google stock price",
      code_json: JSON.stringify({
        tool: "subagent",
        input: { description: "Get Google stock price" },
        native: { callID: "c" },
      }),
    });
    const model = deriveSubagents([withObjective]);
    expect(model.cards.map((c) => c.id)).toEqual(["objective-only"]);
    expect(model.cards[0]?.title).toBe("Get Google stock price");
  });
});

describe("deriveSubagents — T3 lifecycle binding", () => {
  test("attributes T3 task lifecycle rows to the real spawn card by child task id alias", () => {
    const spawn = step({
      id: "nvidia-spawn",
      kind: "task",
      chip: "subagent",
      label: "Find NVIDIA stock price",
      code_json: JSON.stringify({
        source: "t3",
        activityKind: "tool.started",
        tool: "subagent",
        input: { toolCallId: "tool-call-nvidia" },
        output: '<task id="nvidia_price_1" state="running"></task>',
        native: { callID: "tool-call-nvidia", childSessionID: "nvidia_price_1" },
      }),
    });
    const progress = step({
      id: "nvidia-progress",
      kind: "task",
      chip: "task.progress",
      label: "Fetched NVIDIA quote",
      code_json: JSON.stringify({
        source: "t3",
        activityKind: "task.progress",
        tool: "task",
        input: { description: "Fetched NVIDIA quote" },
        native: { callID: "nvidia_price_1" },
      }),
    });

    const model = deriveSubagents([spawn, progress]);

    expect(model.cards).toHaveLength(1);
    expect(model.cards[0]?.callId).toBe("tool-call-nvidia");
    expect(model.cards[0]?.childSessionId).toBe("nvidia_price_1");
    expect(model.cards[0]?.aliases).toEqual(["tool-call-nvidia", "nvidia_price_1"]);
    expect(model.ownerByStep.get("nvidia-progress")).toBe("nvidia-spawn");
    expect(model.cards[0]?.status).toBe("Fetched NVIDIA quote");
  });
});
