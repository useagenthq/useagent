// The imperative shell for run / fan / status. IO is injected (CommandIO) so a command
// can be exercised without touching the real stdout/filesystem. Each returns the process
// exit code. All parsing/formatting lives in the pure modules these delegate to.

import type { FleetClient } from "@useagent/agent-client/fleet";
import type { FanArgs, RunArgs, StatusArgs } from "./args";
import { serializeResults, type FanResultLine } from "./jsonl";
import { parseTasksJsonl } from "./jsonl";
import { formatFanSummary } from "./format";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CommandIO {
  /** Machine output (run ids, JSONL, answers) - stdout. */
  out: (line: string) => void;
  /** Human progress (status lines, summaries, notices) - stderr. */
  err: (line: string) => void;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
}

export async function runCommand(client: FleetClient, args: RunArgs, io: CommandIO): Promise<number> {
  const run = await client.dispatch({
    prompt: args.prompt,
    engine: args.engine,
    model: args.model,
    repos: args.repos,
  });
  io.out(`run ${run.runId}`);
  io.out(run.url);
  if (!args.watch) return 0;

  let lastStatus = "";
  const settled = await client.awaitSettled(run.runId, {
    onPoll: (r) => {
      if (r && r.status !== lastStatus) {
        lastStatus = r.status;
        io.err(`... ${r.status}`);
      }
    },
  });
  io.err(`status: ${settled.status}`);
  if (settled.answer) io.out(settled.answer);
  return settled.status === "completed" ? 0 : 1;
}

export async function statusCommand(client: FleetClient, args: StatusArgs, io: CommandIO): Promise<number> {
  const snapshot = await client.getRun(args.runId);
  if (snapshot.status === "unknown") {
    io.err(`run ${args.runId} not found`);
    return 1;
  }
  io.err(`status: ${snapshot.status}`);
  io.out(snapshot.url);
  if (snapshot.answer) io.out(snapshot.answer);
  return snapshot.status === "failed" ? 1 : 0;
}

export async function fanCommand(client: FleetClient, args: FanArgs, io: CommandIO): Promise<number> {
  const tasks = parseTasksJsonl(await io.readFile(args.file));
  io.err(`dispatching ${tasks.length} task(s), parallelism ${args.parallel}${args.qc ? ", QC on" : ""}...`);

  const outcomes = await client.dispatchMany(tasks, { concurrency: args.parallel });
  const results: FanResultLine[] = await Promise.all(
    outcomes.map(async (outcome): Promise<FanResultLine> => {
      if (!outcome.ok) {
        return { prompt: outcome.task.prompt, runId: null, status: "dispatch_error", answer: "", url: null, error: outcome.error };
      }
      let settled: Awaited<ReturnType<FleetClient["awaitSettled"]>>;
      try {
        settled = await client.awaitSettled(outcome.run.runId);
      } catch (error) {
        return {
          prompt: outcome.task.prompt,
          runId: outcome.run.runId,
          status: "settle_error",
          answer: "",
          url: outcome.run.url,
          error: errorMessage(error),
        };
      }
      const base: FanResultLine = {
        prompt: outcome.task.prompt,
        runId: outcome.run.runId,
        status: settled.status,
        answer: settled.answer,
        url: settled.url,
      };
      if (!args.qc) return base;
      // QC is a real reply run recorded in the SAME thread as the work it judges.
      try {
        const verified = await client.verify(outcome.run.runId, args.qc);
        return { ...base, verdict: verified.verdict };
      } catch (error) {
        return {
          ...base,
          status: "verification_error",
          verdict: "unknown",
          error: errorMessage(error),
        };
      }
    }),
  );

  const jsonl = serializeResults(results);
  if (args.out) {
    await io.writeFile(args.out, jsonl);
    io.err(`wrote ${results.length} result(s) to ${args.out}`);
  } else {
    io.out(jsonl.trimEnd());
  }
  io.err("");
  io.err(formatFanSummary(results));

  const allGood = results.every(
    (r) => r.status === "completed" && r.error === undefined && r.verdict !== "fail",
  );
  return allGood ? 0 : 1;
}
