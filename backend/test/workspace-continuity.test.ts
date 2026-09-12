import { describe, expect, test } from "bun:test";
import { acceptRunCommand } from "../src/commands";
import { clearThreadSandbox, setRunSandbox } from "../src/runs/repo";
import {
  describeLostWorkspace,
  noteLostWorkspace,
  recordSandboxReclaimed,
} from "../src/engines/workspace-continuity";
import type { EmitStep, EngineRunContext } from "../src/engines/types";
import "./helpers"; // side-effect: migrate + seed

// Finding 11: a follow-up whose retained sandbox is gone must say so in the
// timeline and in the turn context instead of silently starting from an empty
// box. Release paths null runs.sandbox_id but keep sandbox_provider, and the
// fleet's capacity reclaim leaves a durable marker naming the reason.
const ORG = "org-skynet-dev";

async function enqueue(id: string, threadId: string, parentRunId: string | null): Promise<void> {
  const out = await acceptRunCommand({
    idempotencyKey: null,
    orgId: ORG,
    actorId: null,
    run: { id, prompt: "x", model: "claude-haiku-4-5", engine: "opencode", parentRunId, threadId },
  });
  expect(out.status).toBe("created");
}

function ctx(runId: string, threadId: string): EngineRunContext & { readonly steps: EmitStep[] } {
  const steps: EmitStep[] = [];
  return {
    steps,
    runId,
    threadId,
    orgId: ORG,
    prompt: "What is in a.txt?",
    bootstrapContext: "",
    turnContext: "<memory>none</memory>\n",
    workdir: "/work",
    signal: new AbortController().signal,
    emit: async (step) => {
      steps.push(step);
      return undefined;
    },
    setSummary: () => {},
  };
}

describe("lost workspace notice", () => {
  test("a thread that never had a sandbox gets no notice", async () => {
    const root = crypto.randomUUID();
    await enqueue(root, root, null);
    expect(await describeLostWorkspace(root, root)).toBeNull();
    const run = ctx(root, root);
    expect(await noteLostWorkspace(run)).toBe(false);
    expect(run.steps).toEqual([]);
    expect(run.turnContext).toBe("<memory>none</memory>\n");
  });

  test("a released or expired workspace is reported as no longer available", async () => {
    const root = crypto.randomUUID();
    await enqueue(root, root, null);
    await setRunSandbox(root, `sbx_${root.slice(0, 8)}`, { kind: "daytona", credential: "env" });
    expect(await clearThreadSandbox(ORG, root, `sbx_${root.slice(0, 8)}`)).toBe(1);

    const reply = crypto.randomUUID();
    await enqueue(reply, root, root);
    const lost = await describeLostWorkspace(root, reply);
    expect(lost?.label).toBe(
      "Earlier workspace is no longer available; starting a fresh sandbox, earlier files are gone",
    );
    expect(lost?.note).toContain("released or expired while idle");
  });

  test("a capacity reclaim names the reason and the note reaches the agent's turn context", async () => {
    const root = crypto.randomUUID();
    const sandboxId = `sbx_${root.slice(0, 8)}`;
    await enqueue(root, root, null);
    await setRunSandbox(root, sandboxId, { kind: "daytona", credential: "env" });
    await clearThreadSandbox(ORG, root, sandboxId);
    await recordSandboxReclaimed({ runId: root, threadId: root, sandboxId });

    const reply = crypto.randomUUID();
    await enqueue(reply, root, root);
    const run = ctx(reply, root);
    expect(await noteLostWorkspace(run)).toBe(true);
    expect(run.steps).toEqual([
      {
        kind: "task",
        chip: "warning",
        label: "Workspace was reclaimed while idle; starting a fresh sandbox, earlier files are gone",
      },
    ]);
    expect(run.turnContext.startsWith("<memory>none</memory>\n")).toBe(true);
    expect(run.turnContext).toContain("<workspace_notice>");
    expect(run.turnContext).toContain("reclaimed while idle to make room");

    // A sandbox provisioned after the reclaim makes the marker history; a later
    // loss is reported generically again.
    await setRunSandbox(reply, `sbx_${reply.slice(0, 8)}`, { kind: "daytona", credential: "env" });
    await clearThreadSandbox(ORG, root, `sbx_${reply.slice(0, 8)}`);
    const later = crypto.randomUUID();
    await enqueue(later, root, root);
    expect((await describeLostWorkspace(root, later))?.label).toContain("no longer available");
  });

  test("a lookup failure never blocks provisioning", async () => {
    const run = ctx("run-x", "thread-x");
    expect(await noteLostWorkspace(run, async () => {
      throw new Error("db down");
    })).toBe(false);
    expect(run.steps).toEqual([]);
  });
});
