import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { getExecutionGraphForRun } from "./execution-graph-repo";
import { executionGraphReadEnabled } from "./execution-graph-rollout";
import { getCustomerRunForOrg } from "./repo";

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export function registerExecutionGraphRoutes(routes: Hono<AppEnv>): void {
  routes.get("/:id/executions", async (c) => {
    if (!executionGraphReadEnabled()) return c.json({ error: "run not found" }, 404);

    const orgId = c.get("orgId");
    const runId = c.req.param("id");
    if (!(await getCustomerRunForOrg(orgId, runId))) {
      return c.json({ error: "run not found" }, 404);
    }
    const graph = await getExecutionGraphForRun(orgId, runId);
    if (!graph) return c.json({ error: "run not found" }, 404);

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
    });
  });
}
