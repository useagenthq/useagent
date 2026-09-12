import { describe, expect, test } from "bun:test";
import type { MergedChildFidelity } from "./canonical-children";
import { projectChildControls, projectChildTree } from "./child-tree-projector";
import type { ExecutionGraphResponse, ExecutionGraphRow } from "./execution-graph-client";
import type { GatewayChildSession } from "./gateway-children";
import type { SubagentCard } from "./subagents";
import type { ThreadRelationship } from "@useagent/agent-client";

const execution = (over: Partial<ExecutionGraphRow> & { id: string }): ExecutionGraphRow => ({
  mode: "native_child",
  provider: "codex",
  native_session_id: over.id,
  native_parent_session_id: null,
  status: "running",
  started_at: "2026-09-01T10:00:00.000Z",
  settled_at: null,
  created_at: "2026-09-01T10:00:00.000Z",
  ...over,
});

const card = (id: string, aliases: readonly string[] = [id]): SubagentCard => ({
  id: `card-${id}`,
  title: `Task ${id}`,
  childSessionId: id,
  callId: `call-${id}`,
  aliases,
  status: "Working",
  startedAt: Date.parse("2026-09-01T10:00:00.000Z"),
  lastActivityAt: null,
});

const fidelity = (id: string, over: Partial<MergedChildFidelity> = {}): MergedChildFidelity => ({
  callId: `call-${id}`,
  childSessionId: id,
  status: "running",
  resultText: null,
  progress: "Working",
  lastToolName: null,
  recentActivity: [],
  usage: null,
  prompt: `Prompt ${id}`,
  model: "gpt-5.6-sol",
  role: "executor",
  resumable: true,
  ...over,
});

const gateway = (id: string, parentRunId: string): GatewayChildSession => ({
  id,
  parentRunId,
  prompt: `Gateway ${id}`,
  engine: "codex",
  model: "openai/gpt-5.6-sol",
  status: "completed",
  summary: "Done",
  durationMs: 1_500,
  createdAt: "2026-09-01T11:00:00.000Z",
});

const product = (
  threadId: string,
  parentThreadId: string | null,
  over: Partial<ThreadRelationship> = {},
): ThreadRelationship => ({
  threadId,
  parentThreadId,
  familyThreadId: "root",
  kind: parentThreadId ? "delegated" : "root",
  title: `Product ${threadId}`,
  sourceRunId: "root",
  sourceExecutionId: null,
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:01.000Z",
  status: "running",
  engine: "codex",
  model: "gpt-5.6-sol",
  latestRunId: threadId,
  latestActivityAt: "2026-09-01T09:00:01.000Z",
  ...over,
});

describe("projectChildTree", () => {
  test("nests durable graph edges and gateway parent runs while preserving lane identity", () => {
    const graph: ExecutionGraphResponse = {
      executions: [
        execution({ id: "root-exec", mode: "root", native_session_id: "root-session" }),
        execution({ id: "exec-a", native_session_id: "native-a" }),
        execution({ id: "exec-b", native_session_id: "native-b" }),
      ],
      delegationEdges: [
        {
          id: "edge-root-a",
          parent_execution_id: "root-exec",
          child_execution_id: "exec-a",
          native_target_session_id: "native-a",
          observed_delivery_seq: 1,
        },
        {
          id: "edge-a-b",
          parent_execution_id: "exec-a",
          child_execution_id: "exec-b",
          native_target_session_id: "native-b",
          observed_delivery_seq: 2,
        },
      ],
    };
    const cards = [card("native-a", ["native-a", "exec-a"]), card("native-b")];
    const tree = projectChildTree({
      cards,
      fidelity: new Map([
        ["native-a", fidelity("native-a")],
        ["native-b", fidelity("native-b", { usage: { totalTokens: 42 } })],
      ]),
      gatewayChildren: [gateway("gateway-a", "root-run"), gateway("gateway-b", "gateway-a")],
      graph,
      runLive: true,
    });

    expect(tree.map((node) => [node.lane, node.title])).toEqual([
      ["native", "Task native-a"],
      ["gateway", "Gateway gateway-a"],
    ]);
    expect(tree[0]?.children[0]?.title).toBe("Task native-b");
    expect(tree[0]?.childCount).toBe(1);
    expect(tree[0]?.children[0]?.usage?.totalTokens).toBe(42);
    expect(tree[1]?.children[0]?.lane).toBe("gateway");
    expect(tree[1]?.children[0]?.elapsedMs).toBe(1_500);
  });

  test("deduplicates a gateway/native alias in favor of the durable gateway run", () => {
    const tree = projectChildTree({
      cards: [card("gateway-a", ["call-a", "gateway-a"])],
      fidelity: new Map([["gateway-a", fidelity("gateway-a")]]),
      gatewayChildren: [gateway("gateway-a", "root")],
      graph: {
        executions: [execution({ id: "exec-a", native_session_id: "gateway-a" })],
        delegationEdges: [],
      },
      runLive: false,
    });
    expect(tree).toHaveLength(1);
    expect(tree[0]?.lane).toBe("gateway");
  });

  test("durable graph settlement overrides stale Working fidelity", () => {
    const tree = projectChildTree({
      cards: [card("native-a")],
      fidelity: new Map([["native-a", fidelity("native-a", {
        status: "running",
        progress: "Working",
      })]]),
      gatewayChildren: [],
      graph: {
        executions: [execution({
          id: "exec-a",
          native_session_id: "native-a",
          status: "completed",
          settled_at: "2026-09-01T10:00:03.000Z",
        })],
        delegationEdges: [],
      },
      runLive: true,
    });
    expect(tree[0]?.status).toBe("completed");
    expect(tree[0]?.progress).toBeNull();
    expect(tree[0]?.elapsedMs).toBe(3_000);
  });

  test("makes ordinary product threads primary and nests their product descendants", () => {
    const tree = projectChildTree({
      cards: [],
      fidelity: new Map(),
      gatewayChildren: [],
      productChildren: [
        product("child-a", "root"),
        product("child-b", "child-a", { status: "completed" }),
      ],
      runLive: true,
    });
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ lane: "product", title: "Product child-a" });
    expect(tree[0]?.children[0]).toMatchObject({
      lane: "product",
      title: "Product child-b",
      status: "completed",
    });
  });

  test("keeps source execution provenance separate from a native child binding", () => {
    const tree = projectChildTree({
      cards: [card("native-a", ["native-a", "exec-a"])],
      fidelity: new Map([["native-a", fidelity("native-a")]]),
      gatewayChildren: [],
      productChildren: [product("child-a", "root", { sourceExecutionId: "exec-a" })],
      graph: {
        executions: [execution({ id: "exec-a", native_session_id: "native-a" })],
        delegationEdges: [],
      },
      runLive: true,
    });
    expect(tree.map((node) => node.lane)).toEqual(["product", "native"]);
  });

  test("attaches a product child's native graph only through its exact thread binding", () => {
    const child = product("child-a", "root", { latestRunId: "run-child-a" });
    const graph = {
      executions: [execution({ id: "exec-a", native_session_id: "native-a" })],
      delegationEdges: [],
    };
    const tree = projectChildTree({
      cards: [],
      fidelity: new Map(),
      gatewayChildren: [],
      productChildren: [child],
      productGraphs: new Map([[child.threadId, graph]]),
      runLive: true,
    });
    expect(tree).toHaveLength(1);
    expect(tree[0]?.id).toBe("product:child-a");
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]).toMatchObject({
      id: "native:exec-a",
      lane: "native",
      executionId: "exec-a",
      executionRunId: "run-child-a",
      productParentThreadId: "child-a",
    });
  });

  test("keeps missing-parent children visible and is deterministic under replay/order changes", () => {
    const executions = [
      execution({ id: "b", native_session_id: "b", created_at: "2026-09-01T10:00:01Z" }),
      execution({ id: "a", native_session_id: "a", created_at: "2026-09-01T10:00:00Z" }),
    ];
    const edge = {
      id: "missing-parent",
      parent_execution_id: "gone",
      child_execution_id: "b",
      native_target_session_id: "b",
      observed_delivery_seq: 8,
    } as const;
    const project = (graphExecutions: readonly ExecutionGraphRow[]) => projectChildTree({
      cards: [],
      fidelity: new Map(),
      gatewayChildren: [],
      graph: { executions: graphExecutions, delegationEdges: [edge, edge] },
      runLive: false,
    }).map((node) => node.id);

    expect(project(executions)).toEqual(["native:a", "native:b"]);
    expect(project(executions.toReversed())).toEqual(["native:a", "native:b"]);
  });
});

describe("projectChildControls", () => {
  test("never turns negotiated provider support into a fake child action", () => {
    const controls = projectChildControls({
      lane: "native",
      status: "running",
      resumable: true,
      capabilities: { resume: true, stop: true, steer: true, close: true },
    });
    expect(controls.resume).toEqual({
      available: false,
      reason: "Resume is negotiated, but no child-targeted resume route is available.",
    });
    expect(controls.cancel.available).toBe(false);
    expect(controls.steer.available).toBe(false);
    expect("close" in controls).toBe(false);
  });

  test("gateway continuation stays on the existing child session route", () => {
    expect(projectChildControls({
      lane: "gateway",
      status: "completed",
      resumable: true,
      capabilities: null,
    }).resume).toEqual({ available: true, reason: null });
  });

  test("product children expose the ordinary session message path", () => {
    const controls = projectChildControls({
      lane: "product",
      status: "running",
      resumable: true,
      capabilities: null,
    });
    expect(controls.resume.available).toBe(true);
    expect(controls.steer.available).toBe(true);
    expect(controls.cancel.available).toBe(false);
  });
});
