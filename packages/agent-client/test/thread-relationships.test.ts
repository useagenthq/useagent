import { describe, expect, test } from "bun:test";
import {
  decodeThreadFamilyPage,
  decodeThreadRelationship,
  decodeThreadRelationshipEnvelope,
} from "../src/thread-relationships";

const relationship = {
  thread_id: "child-1",
  parent_thread_id: "parent-1",
  family_thread_id: "parent-1",
  kind: "delegated",
  title: "Build calendar grid",
  source_run_id: "parent-run-1",
  source_execution_id: null,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:01:00.000Z",
  status: "running",
  engine: "codex",
  model: "gpt-5.6-sol",
  latest_run_id: "child-1",
  latest_summary: "Calendar grid complete.",
  latest_duration_ms: 1_250,
  latest_activity_at: "2026-09-01T00:01:00.000Z",
};

describe("thread relationship wire contract", () => {
  test("decodes bounded public fields and drops tenant/provider internals", () => {
    expect(decodeThreadRelationship({
      ...relationship,
      org_id: "must-not-cross",
      provider_session_id: "must-not-cross",
      credential: "must-not-cross",
    })).toEqual({
      threadId: "child-1",
      parentThreadId: "parent-1",
      familyThreadId: "parent-1",
      kind: "delegated",
      title: "Build calendar grid",
      sourceRunId: "parent-run-1",
      sourceExecutionId: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
      status: "running",
      engine: "codex",
      model: "gpt-5.6-sol",
      latestRunId: "child-1",
      latestSummary: "Calendar grid complete.",
      latestDurationMs: 1_250,
      latestActivityAt: "2026-09-01T00:01:00.000Z",
      bot: null,
      followUpRunIds: [],
    });
  });

  test("rejects malformed identity, enums, and missing derived status", () => {
    expect(decodeThreadRelationship({ ...relationship, thread_id: "" })).toBeNull();
    expect(decodeThreadRelationship({ ...relationship, kind: "native" })).toBeNull();
    expect(decodeThreadRelationship({ ...relationship, status: "idle" })).toBeNull();
    expect(decodeThreadRelationship({ ...relationship, engine: "unknown" })).toBeNull();
    expect(decodeThreadRelationship({ ...relationship, latest_run_id: null })).toBeNull();
    expect(decodeThreadRelationship({ ...relationship, latest_duration_ms: -1 })).toBeNull();
  });

  test("decodes single and paginated envelopes without accepting partial rows", () => {
    expect(decodeThreadRelationshipEnvelope({ relationship })?.threadId).toBe("child-1");
    expect(decodeThreadFamilyPage({
      children: [relationship],
      next_cursor: "cursor-2",
      has_more: true,
    })).toMatchObject({ nextCursor: "cursor-2", hasMore: true });
    expect(decodeThreadFamilyPage({
      children: [relationship, { ...relationship, model: null }],
      next_cursor: null,
      has_more: false,
    })).toBeNull();
  });
});
