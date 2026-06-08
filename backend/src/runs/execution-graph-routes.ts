import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { loadCanonicalExecutionEvents } from "./canonical-events";
import {
  getExecutionForOrgRun,
  getExecutionGraphPageForRun,
  type ExecutionGraphPageCursor,
} from "./execution-graph-repo";
import { executionGraphReadEnabled } from "./execution-graph-rollout";
import { getCustomerRunForOrg } from "./repo";

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

const EXECUTION_GRAPH_DEFAULT_LIMIT = 50;
const EXECUTION_GRAPH_MAX_LIMIT = 100;
const EXECUTION_GRAPH_MAX_CURSOR_LENGTH = 1_024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTGRES_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::?\d{2})?$/;

interface ExecutionGraphCursorWire {
  readonly v: 1;
  readonly graph_cursor: number;
  readonly execution: {
    readonly created_at: string;
    readonly id: string;
  } | null;
  readonly delegation_edge: {
    readonly cursor_seq: number;
  } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseExecutionGraphCursor(value: string | undefined): ExecutionGraphPageCursor {
  if (value === undefined) return { graphCursor: 0, execution: null, delegationEdge: null };
  if (
    !value ||
    value.length > EXECUTION_GRAPH_MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) throw new Error("invalid_cursor");

  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("invalid_cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error("invalid_cursor");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["v", "graph_cursor", "execution", "delegation_edge"])
  ) {
    throw new Error("invalid_cursor");
  }
  if (parsed.v !== 1) throw new Error("invalid_cursor");
  if (!Number.isSafeInteger(parsed.graph_cursor) || (parsed.graph_cursor as number) < 0) {
    throw new Error("invalid_cursor");
  }

  let execution: ExecutionGraphPageCursor["execution"] = null;
  if (parsed.execution !== null) {
    if (!isRecord(parsed.execution) || !hasExactKeys(parsed.execution, ["created_at", "id"])) {
      throw new Error("invalid_cursor");
    }
    const { created_at: createdAtValue, id } = parsed.execution;
    if (typeof createdAtValue !== "string" || typeof id !== "string" || !UUID_RE.test(id)) {
      throw new Error("invalid_cursor");
    }
    if (
      !POSTGRES_TIMESTAMP_RE.test(createdAtValue) ||
      !Number.isFinite(Date.parse(createdAtValue))
    ) {
      throw new Error("invalid_cursor");
    }
    execution = { createdAt: createdAtValue, id };
  }

  let delegationEdge: ExecutionGraphPageCursor["delegationEdge"] = null;
  if (parsed.delegation_edge !== null) {
    if (
      !isRecord(parsed.delegation_edge) ||
      !hasExactKeys(parsed.delegation_edge, ["cursor_seq"])
    ) {
      throw new Error("invalid_cursor");
    }
    const { cursor_seq: cursorSeq } = parsed.delegation_edge;
    if (
      !Number.isSafeInteger(cursorSeq) ||
      (cursorSeq as number) < 1
    ) {
      throw new Error("invalid_cursor");
    }
    delegationEdge = { cursorSeq: cursorSeq as number };
  }

  return { graphCursor: parsed.graph_cursor as number, execution, delegationEdge };
}

function encodeExecutionGraphCursor(cursor: ExecutionGraphPageCursor): string {
  const wire: ExecutionGraphCursorWire = {
    v: 1,
    graph_cursor: cursor.graphCursor,
    execution: cursor.execution
      ? { created_at: cursor.execution.createdAt, id: cursor.execution.id }
      : null,
    delegation_edge: cursor.delegationEdge
      ? {
          cursor_seq: cursor.delegationEdge.cursorSeq,
        }
      : null,
  };
  return Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
}

function parseExecutionGraphLimit(value: string | undefined): number {
  if (value === undefined) return EXECUTION_GRAPH_DEFAULT_LIMIT;
  if (!/^[1-9]\d*$/.test(value)) throw new Error("invalid_limit");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EXECUTION_GRAPH_MAX_LIMIT) {
    throw new Error("invalid_limit");
  }
  return limit;
}

export function registerExecutionGraphRoutes(routes: Hono<AppEnv>): void {
  routes.get("/:id/executions", async (c) => {
    if (!executionGraphReadEnabled()) return c.json({ error: "run not found" }, 404);

    const orgId = c.get("orgId");
    const runId = c.req.param("id");
    if (!(await getCustomerRunForOrg(orgId, runId))) {
      return c.json({ error: "run not found" }, 404);
    }
    let limit: number;
    let cursor: ExecutionGraphPageCursor;
    try {
      limit = parseExecutionGraphLimit(c.req.query("limit"));
      cursor = parseExecutionGraphCursor(c.req.query("cursor"));
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_limit") {
        return c.json({ error: "limit must be an integer between 1 and 100" }, 400);
      }
      return c.json({ error: "cursor is invalid" }, 400);
    }
    const graph = await getExecutionGraphPageForRun(orgId, runId, { limit, cursor });
    if (!graph) return c.json({ error: "run not found" }, 404);
    const hasMore = graph.executionHasMore || graph.delegationEdgeHasMore;
    const hasCursorPosition =
      graph.nextCursor.execution !== null || graph.nextCursor.delegationEdge !== null;

    return c.json({
      version: graph.version,
      run_id: graph.runId,
      graph_cursor: graph.graphCursor,
      executions: graph.executions.map((execution) => ({
        id: execution.id,
        run_id: execution.runId,
        mode: execution.mode,
        provider: execution.provider,
        native_session_id: execution.nativeSessionId,
        native_parent_session_id: execution.nativeParentSessionId,
        status: execution.status,
        attempt: execution.attempt,
        last_event_id: execution.lastEventId,
        last_event_revision: execution.lastEventRevision,
        last_delivery_seq: execution.lastDeliverySeq,
        started_at: iso(execution.startedAt),
        settled_at: iso(execution.settledAt),
        created_at: execution.createdAt.toISOString(),
        updated_at: execution.updatedAt.toISOString(),
      })),
      delegation_edges: graph.delegationEdges.map((edge) => ({
        id: edge.id,
        run_id: edge.runId,
        parent_execution_id: edge.parentExecutionId,
        child_execution_id: edge.childExecutionId,
        kind: edge.kind,
        provider: edge.provider,
        provider_call_id: edge.providerCallId,
        native_event_id: edge.nativeEventId,
        native_target_session_id: edge.nativeTargetSessionId,
        observed_delivery_seq: edge.observedDeliverySeq,
        created_at: edge.createdAt.toISOString(),
      })),
      has_more: hasMore,
      next_cursor: hasCursorPosition ? encodeExecutionGraphCursor(graph.nextCursor) : null,
    });
  });

  routes.get("/:id/executions/:executionId/events", async (c) => {
    if (!executionGraphReadEnabled()) return c.json({ error: "run not found" }, 404);

    const orgId = c.get("orgId");
    const runId = c.req.param("id");
    if (!(await getCustomerRunForOrg(orgId, runId))) {
      return c.json({ error: "run not found" }, 404);
    }
    const execution = await getExecutionForOrgRun(orgId, runId, c.req.param("executionId"));
    if (!execution) return c.json({ error: "execution not found" }, 404);

    const cursor = Number(c.req.query("cursor") ?? "0");
    const requestedLimit = Number(c.req.query("limit") ?? "50");
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return c.json({ error: "cursor must be a non-negative integer" }, 400);
    }
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      return c.json({ error: "limit must be a positive integer" }, 400);
    }
    const limit = Math.min(requestedLimit, 200);
    const rows = execution.nativeSessionId
      ? await loadCanonicalExecutionEvents({
          runId,
          provider: execution.provider,
          nativeSessionId: execution.nativeSessionId,
          afterDeliverySeq: cursor,
          limit: limit + 1,
        })
      : [];
    const events = rows.slice(0, limit);

    return c.json({
      version: 1,
      run_id: runId,
      execution_id: execution.id,
      cursor,
      next_cursor: events.at(-1)?.deliverySeq ?? cursor,
      has_more: rows.length > limit,
      events,
    });
  });
}
