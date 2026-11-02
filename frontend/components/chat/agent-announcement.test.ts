import { describe, expect, test } from "bun:test";
import { type AgentActivity, agentAnnouncement } from "./agent-announcement";

const IDLE: AgentActivity = {
  running: false,
  outcome: null,
  approvalId: null,
  questionId: null,
  pendingApprovalIds: [],
};

const running = (over: Partial<AgentActivity> = {}): AgentActivity => ({
  ...IDLE,
  running: true,
  ...over,
});

describe("agentAnnouncement", () => {
  test("the first snapshot establishes a baseline and announces nothing", () => {
    // Opening a thread whose agent already replied must not read a stale event.
    expect(agentAnnouncement(null, { ...IDLE, outcome: "replied" })).toBeNull();
    expect(agentAnnouncement(null, { ...IDLE, approvalId: "a1" })).toBeNull();
  });

  test("a finished reply is announced once, on the running to settled edge", () => {
    const before = running();
    const after: AgentActivity = { ...IDLE, outcome: "replied" };
    expect(agentAnnouncement(before, after)).toBe("The agent replied.");
    // The same settled snapshot repeated is not a new event.
    expect(agentAnnouncement(after, after)).toBeNull();
  });

  test("a user stop is announced, distinct from a reply", () => {
    expect(agentAnnouncement(running(), { ...IDLE, outcome: "stopped" })).toBe(
      "The agent stopped.",
    );
  });

  test("a real failure is left to the error banner (never announced here)", () => {
    // A real failure comes in as outcome null, so we say nothing here.
    expect(agentAnnouncement(running(), { ...IDLE, outcome: null })).toBeNull();
  });

  test("a new native approval is announced when it appears", () => {
    expect(agentAnnouncement(running(), running({ approvalId: "ap1" }))).toBe(
      "The agent needs your approval.",
    );
  });

  test("a resolved approval is not re-announced", () => {
    const waiting = running({ approvalId: "ap1" });
    expect(agentAnnouncement(waiting, running())).toBeNull();
  });

  test("a different approval replacing the last one counts as a new event", () => {
    const first = running({ approvalId: "ap1" });
    expect(agentAnnouncement(first, running({ approvalId: "ap2" }))).toBe(
      "The agent needs your approval.",
    );
  });

  test("a newly pending gateway approval is announced", () => {
    const before = running({ pendingApprovalIds: ["g1"] });
    expect(agentAnnouncement(before, running({ pendingApprovalIds: ["g1", "g2"] }))).toBe(
      "The agent needs your approval.",
    );
    // A pending approval already present at baseline is not a fresh event.
    expect(agentAnnouncement(before, before)).toBeNull();
  });

  test("a new native question is announced", () => {
    expect(agentAnnouncement(running(), running({ questionId: "q1" }))).toBe(
      "The agent has a question.",
    );
  });

  test("a request the person must act on wins over a settled outcome", () => {
    // Both edges in one transition: the blocking request is what to hear.
    const before = running();
    const after: AgentActivity = { ...IDLE, outcome: "replied", approvalId: "ap1" };
    expect(agentAnnouncement(before, after)).toBe("The agent needs your approval.");
  });

  test("nothing new produces no announcement", () => {
    expect(agentAnnouncement(running(), running())).toBeNull();
    expect(agentAnnouncement(IDLE, IDLE)).toBeNull();
  });
});
