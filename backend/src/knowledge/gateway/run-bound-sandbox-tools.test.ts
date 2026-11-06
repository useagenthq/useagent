import { afterAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { runs } from "../../db/schema";
import { createRun, setRunSandbox, setRunStatus } from "../../runs/repo";
import type { SandboxHandle } from "../../sandboxes/provider";
import * as bindings from "../../sandboxes/binding";
import { executeComputerUseTool } from "./computer-use-tools";
import { executeRecordingTool } from "./recording-tools";
import { childSessionToolsEnabled, executeChildSessionTool } from "./child-session-tools";
import type { ToolTokenClaims } from "./token";
import { SANDBOX_NAME_PREFIX } from "../../sandboxes/sandbox-names";

const ORG = "org-run-bound-sandbox-tools-test";

afterAll(async () => {
  await db.delete(runs).where(eq(runs.orgId, ORG));
});

test("computer and recording operations resolve the full fenced run", async () => {
  const runId = crypto.randomUUID();
  const expectedSandbox = {
    version: 1 as const,
    sandboxId: "sandbox-1",
    provider: "box" as const,
    credential: "env" as const,
    ownerOrgId: ORG,
    ownerUserId: null,
    credentialGeneration: "a".repeat(64),
  };
  await createRun({
    id: runId,
    prompt: "tool fence",
    model: "gpt-5.6-luna",
    engine: "codex",
    orgId: ORG,
    userId: "user-1",
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
    expectedSandbox,
  });
  await setRunSandbox(runId, "sandbox-1", { kind: "box", credential: "env" });
  const commands: string[] = [];
  const sandbox = {
    id: "sandbox-1",
    providerKind: "box",
    desktop: {
      display: ":0",
      home: "/home/user",
      workdir: "/home/user/work",
      browserExecutable: null,
      start: async () => {},
    },
    process: {
      executeCommand: async (command: string) => {
        commands.push(command);
        return {
          exitCode: 0,
          result: command.startsWith(`${SANDBOX_NAME_PREFIX}-record-start`)
            ? "/home/user/work/recordings/proof.mp4\n"
            : "",
        };
      },
    },
  } as unknown as SandboxHandle;
  const resolve = spyOn(bindings, "resolveRunSandbox").mockResolvedValue(sandbox);
  const claims: ToolTokenClaims = {
    orgId: ORG,
    userId: "user-1",
    threadId: runId,
    runId,
    scope: "run",
    exp: Date.now() + 60_000,
  };

  try {
    expect((await executeComputerUseTool(
      claims,
      "computer_click",
      { x: 1, y: 2 },
    )).isError).toBeUndefined();
    expect((await executeRecordingTool(
      claims,
      "desktop_recording_start",
      { name: "proof" },
    )).isError).toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(2);
    for (const [run] of resolve.mock.calls) {
      expect(run).toMatchObject({
        orgId: ORG,
        threadId: runId,
        sandboxId: "sandbox-1",
        expectedSandbox,
      });
    }
    expect(commands).toHaveLength(2);
    await setRunStatus(runId, "running");
    expect(await childSessionToolsEnabled(claims)).toBe(false);
    expect((await executeChildSessionTool(claims, "child_session_create", {
      idempotencyKey: "no-unbudgeted-child", prompt: "Do not dispatch.",
    })).isError).toBe(true);
    expect(await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ORG))).toHaveLength(1);
    await db.update(runs).set({ expectedSandbox: null }).where(eq(runs.id, runId));
    expect(await childSessionToolsEnabled(claims)).toBe(true);
  } finally {
    resolve.mockRestore();
  }
});
