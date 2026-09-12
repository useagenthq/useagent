// The chat engine stores the sources it retrieved on the run's done step
// (code_json.citations) and the reply must show them: a compact "Sources"
// strip under the answer, one chip per distinct citation, six at most.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type ChatCitation, ChatSourcesRow, chatCitationsFromSteps } from "./chat-citations";
import { Conversation, type Turn } from "./conversation";
import chat from "./fixtures/engine-runs/chat.json";
import type { ApiRun, ApiStep } from "./types";

const STEPS = chat.steps as ApiStep[];
const WORK_STEPS = STEPS.filter((step) => step.kind !== "done");

/** The fixture's done step with a different stored payload. */
function doneStep(code_json: string | null): ApiStep {
  return {
    id: "chat-step-done",
    run_id: "chat-run",
    idx: 1,
    kind: "done",
    label: "Done",
    chip: null,
    code_json,
    created_at: "2030-01-01T00:00:01.200Z",
  };
}

function chatTurn(steps: readonly ApiStep[] = STEPS): Turn {
  const run: ApiRun = {
    id: "chat-run",
    org_id: null,
    user_id: null,
    prompt: "How should a retry budget work?",
    model: "claude-sonnet-5",
    engine: "chat",
    status: "completed",
    summary: chat.summary,
    duration_ms: chat.duration_ms,
    parent_run_id: null,
    child_session: false,
    thread_id: "chat-run",
    engine_session_id: null,
    sandbox_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    resolved_resources: [],
    memory_scope: "org",
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-01T00:00:01Z",
    steps: [...steps],
  };
  return {
    run,
    steps: [...steps],
    status: "completed",
    summary: run.summary,
    live: false,
    liveText: "",
    liveReasoning: "",
  };
}

function render(turn: Turn): string {
  return renderToStaticMarkup(
    <Conversation
      turns={[turn]}
      defaultEngine="chat"
      defaultModel="claude-sonnet-5"
      defaultMemoryScope="org"
      pendingReply={null}
      onReply={async () => {}}
    />,
  );
}

/** Text a person would see: tags stripped, entities decoded. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("chat reply sources", () => {
  test("a settled chat turn renders its stored citations as a Sources strip under the reply", () => {
    const html = render(chatTurn());
    const text = visibleText(html);
    expect(html).toContain('data-testid="chat-sources"');
    expect(text).toContain("Sources");
    // The strip closes the reply: it sits after the answer, never above it.
    expect(html.indexOf('data-testid="chat-sources"')).toBeGreaterThan(
      html.indexOf('data-testid="agent-answer"'),
    );
    // Ten stored, nine distinct, six shown, the rest counted.
    expect(html.match(/data-testid="chat-source"/g)).toHaveLength(6);
    expect(text).toContain("+3 more");
    // Each chip names its title and where it came from.
    expect(text).toContain("Retry Budgets");
    expect(text).toContain("wiki");
    expect(text).toContain("memory");
  });

  test("stored HTML entities in a title read as the character, not the entity", () => {
    const html = render(chatTurn());
    expect(visibleText(html)).toContain("Deployments & Rollbacks");
    expect(html).not.toContain("&amp;amp;");
  });

  test("a chat turn whose done step stored no citations renders no strip", () => {
    const html = render(chatTurn([...WORK_STEPS, doneStep('{"citations":[]}')]));
    expect(html).toContain('data-testid="agent-answer"');
    expect(html).not.toContain('data-testid="chat-sources"');
    expect(html).not.toContain("Sources");
  });
});

describe("chatCitationsFromSteps", () => {
  test("reads the done step, decodes titles, and collapses duplicates in stored order", () => {
    const citations = chatCitationsFromSteps(STEPS);
    expect(citations).toHaveLength(9);
    expect(citations[0]).toEqual({ title: "Retry Budgets", source: "wiki" });
    expect(citations[1]).toEqual({ title: "Deployments & Rollbacks", source: "wiki" });
    expect(citations.filter((c) => c.title === "Deployments & Rollbacks")).toHaveLength(1);
    expect(citations.map((c) => c.source)).toEqual([
      "wiki",
      "wiki",
      "wiki",
      "wiki",
      "memory",
      "memory",
      "memory",
      "memory",
      "memory",
    ]);
  });

  test("the same title from two substrates stays two citations", () => {
    const steps = [
      doneStep(
        '{"citations":[{"title":"Retry Budgets","source":"wiki"},{"title":"Retry Budgets","source":"memory"}]}',
      ),
    ];
    expect(chatCitationsFromSteps(steps)).toHaveLength(2);
  });

  test("drops malformed entries and unknown substrates, and copes with no done step at all", () => {
    const steps = [
      doneStep(
        '{"citations":[{"title":"","source":"wiki"},{"title":"x","source":"web"},{"source":"memory"},"junk",{"title":"Kept","source":"knowledge"}]}',
      ),
    ];
    expect(chatCitationsFromSteps(steps)).toEqual([{ title: "Kept", source: "knowledge" }]);
    expect(chatCitationsFromSteps(WORK_STEPS)).toEqual([]);
    expect(chatCitationsFromSteps([doneStep(null)])).toEqual([]);
    expect(chatCitationsFromSteps([doneStep("not json")])).toEqual([]);
    expect(chatCitationsFromSteps([doneStep('{"citations":"nope"}')])).toEqual([]);
  });
});

describe("ChatSourcesRow", () => {
  const cite = (n: number): ChatCitation => ({ title: `Page ${n}`, source: "wiki" });

  test("six or fewer citations render as chips with no count", () => {
    const html = renderToStaticMarkup(<ChatSourcesRow citations={[1, 2, 3, 4, 5, 6].map(cite)} />);
    expect(html.match(/data-testid="chat-source"/g)).toHaveLength(6);
    expect(html).not.toContain("more");
  });

  test("beyond six, the strip shows six and counts the rest", () => {
    const html = renderToStaticMarkup(
      <ChatSourcesRow citations={[1, 2, 3, 4, 5, 6, 7, 8].map(cite)} />,
    );
    expect(html.match(/data-testid="chat-source"/g)).toHaveLength(6);
    expect(html).toContain("+2 more");
    expect(html).not.toContain("Page 7");
  });

  test("nothing cited renders nothing", () => {
    expect(renderToStaticMarkup(<ChatSourcesRow citations={[]} />)).toBe("");
  });
});
