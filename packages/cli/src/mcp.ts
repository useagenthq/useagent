// A stdio MCP server exposing the fleet to a LOCAL agent (Claude Code etc.): dispatch one
// or many cloud runs, collect settle-aware results (optionally QC-verified), and list
// recent runs. Built on the low-level SDK Server (JSON-Schema tools, no extra runtime
// dep) so it mirrors the backend's use of @modelcontextprotocol/sdk. The client is
// injected, so createFleetMcpServer is testable without a transport.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { FleetClient } from "@useagent/agent-client/fleet";
import { coerceTask } from "./task";

const TASK_SHAPE: Tool["inputSchema"] = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "The task instruction." },
    engine: { type: "string", description: "Engine id (codex, claude, opencode, pi). Optional." },
    model: { type: "string", description: "Model id. Optional." },
    repos: { type: "array", items: { type: "string" }, description: "Repos as owner/name. Optional." },
  },
  required: ["prompt"],
};

export const FLEET_TOOLS: Tool[] = [
  {
    name: "dispatch_task",
    description:
      "Dispatch ONE task to the hosted org as a cloud run. Returns the run id + web url immediately (does not wait for completion).",
    inputSchema: TASK_SHAPE,
  },
  {
    name: "dispatch_parallel",
    description:
      "Dispatch MANY tasks in parallel with bounded concurrency. Returns run ids immediately (does not wait). Pass `qc` to record the verifier prompt to run later via get_run_result.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: { type: "array", items: TASK_SHAPE, description: "Tasks to dispatch." },
        concurrency: { type: "number", description: "Max in-flight dispatches (default 4)." },
        qc: { type: "string", description: "Optional verifier prompt to reuse with get_run_result." },
      },
      required: ["tasks"],
    },
  },
  {
    name: "get_run_result",
    description:
      "Settle-aware: poll a run until it is completed/failed (or timeoutMs elapses) and return its final answer. Pass `qc` to also run an in-thread verifier and return its VERDICT.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "The run id to collect." },
        timeoutMs: { type: "number", description: "Max wait in ms (default 900000 = 15 min)." },
        qc: { type: "string", description: "Optional verifier prompt; posts a QC reply run and parses its VERDICT." },
      },
      required: ["runId"],
    },
  },
  {
    name: "list_recent_runs",
    description: "List recent runs (newest first) for the authenticated org.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max rows (default 20)." } },
    },
  },
];

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export async function handleToolCall(
  client: FleetClient,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  switch (name) {
    case "dispatch_task": {
      const task = coerceTask(args);
      if (!task) return errorResult('dispatch_task needs a non-empty "prompt"');
      return jsonResult(await client.dispatch(task));
    }
    case "dispatch_parallel": {
      const rawTasks = Array.isArray(args.tasks) ? args.tasks : null;
      if (!rawTasks) return errorResult("dispatch_parallel needs a `tasks` array");
      const tasks = rawTasks.map(coerceTask);
      if (tasks.some((t) => t === null)) {
        return errorResult('every task needs a non-empty "prompt"');
      }
      const outcomes = await client.dispatchMany(
        tasks.filter((t): t is NonNullable<typeof t> => t !== null),
        { concurrency: num(args, "concurrency") ?? 4 },
      );
      const runs = outcomes.map((o) =>
        o.ok
          ? { prompt: o.task.prompt, runId: o.run.runId, status: o.run.status, url: o.run.url }
          : { prompt: o.task.prompt, error: o.error },
      );
      const qc = str(args, "qc");
      return jsonResult(qc ? { runs, qc } : { runs });
    }
    case "get_run_result": {
      const runId = str(args, "runId");
      if (!runId) return errorResult("get_run_result needs a `runId`");
      const timeoutMs = num(args, "timeoutMs");
      const settled = await client.awaitSettled(runId, timeoutMs !== undefined ? { timeoutMs } : {});
      const qc = str(args, "qc");
      if (!qc) {
        return jsonResult({ runId: settled.runId, status: settled.status, answer: settled.answer, url: settled.url });
      }
      const verified = await client.verify(runId, qc, timeoutMs !== undefined ? { timeoutMs } : {});
      return jsonResult({
        runId: settled.runId,
        status: settled.status,
        answer: settled.answer,
        url: settled.url,
        verdict: verified.verdict,
        verifierRunId: verified.runId,
        evidence: verified.evidence,
      });
    }
    case "list_recent_runs": {
      const runs = await client.listRecent(num(args, "limit") ?? 20);
      return jsonResult(
        runs.map((r) => ({
          runId: r.id,
          status: r.status,
          engine: r.engine,
          model: r.model,
          prompt: r.prompt,
          url: client.urlFor(r.id),
          updatedAt: r.updated_at,
        })),
      );
    }
    default:
      return errorResult(`unknown tool: ${name}`);
  }
}

export function createFleetMcpServer(client: FleetClient): Server {
  const server = new Server(
    { name: "useagent-fleet", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FLEET_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await handleToolCall(client, request.params.name, request.params.arguments ?? {});
    } catch (e) {
      return errorResult(`tool ${request.params.name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return server;
}

/** Connect the server over stdio and stay attached until the transport closes. */
export async function runMcpServer(client: FleetClient): Promise<void> {
  const server = createFleetMcpServer(client);
  await server.connect(new StdioServerTransport());
}
