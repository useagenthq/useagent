import { describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ensureRepoClone as realEnsureRepoClone } from "../../engines/repo-prep";
import { db } from "../../db/client";
import { runs } from "../../db/schema";
import { createRun, setRunSandbox } from "../../runs/repo";
import type { SandboxHandle } from "../../sandboxes/provider";
import type { ToolTokenClaims } from "./token";
import * as repoPrepModule from "../../engines/repo-prep";
import * as githubReposModule from "../../github/repos";
import * as sandboxProviderModule from "../../sandboxes/provider";

const ensureRepoClone = mock(async (
  ...args: Parameters<typeof realEnsureRepoClone>
) => {
  const [sandbox, workdir, entry, ctx, options] = args;
  if (
    workdir === "/root/work" &&
    entry === "upstream-org/backend" &&
    ctx.orgId === "org-1" &&
    options?.useGithubCredential === true
  ) {
    return undefined;
  }
  return repoPrepModule.ensureRepoClone(...args);
});
const executeCommand = mock(async () => ({
  exitCode: 0,
  result: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d\nmain\n",
}));

mock.module("../../engines/repo-prep", () => ({
  ...repoPrepModule,
  ensureRepoClone,
  shq: (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
}));

mock.module("../../github/repos", () => ({
  ...githubReposModule,
  listRepos: async (orgId: string) =>
    orgId === "org-1"
      ? {
          configured: true,
          repos: [{
            full_name: "upstream-org/backend",
            name: "backend",
            private: true,
            default_branch: "main",
          }],
        }
      : githubReposModule.listRepos(orgId),
}));

mock.module("../../sandboxes/provider", () => ({
  ...sandboxProviderModule,
  sandboxProviderApiKey: () => "sandbox-key",
  sandboxProvider: (apiKey: string) => {
    if (apiKey === "sandbox-key") {
      return {
        get: async (sandboxId: string): Promise<SandboxHandle> => {
          expect(sandboxId).toBe("sandbox-1");
          return sandboxHandle();
        },
      };
    }
    return sandboxProviderModule.sandboxProvider(apiKey);
  },
}));

const { executeRepositoryTool } = await import("./repository-tools");

describe("repository gateway production clone", () => {
  test("passes the signed organization id into the credentialed clone boundary", async () => {
    const runId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const claims: ToolTokenClaims = {
      orgId: "org-1",
      userId: "user-1",
      threadId,
      runId,
      scope: "run",
      exp: Date.now() + 60_000,
    };
    await createRun({
      id: runId,
      prompt: "prepare repo clone",
      model: "gpt-5.6-luna",
      engine: "codex",
      orgId: claims.orgId,
      userId: claims.userId,
      parentRunId: null,
      threadId: claims.threadId,
      repos: ["upstream-org/backend"],
      memoryScope: "org",
    });
    await setRunSandbox(runId, "sandbox-1");

    try {
      const response = await executeRepositoryTool(claims, "github_clone_repository", {
        query: "upstream-org/backend",
      });

      expect(response.isError).toBeUndefined();
      expect(ensureRepoClone).toHaveBeenCalledTimes(1);
      expect(ensureRepoClone.mock.calls[0]?.[3]).toEqual({
        emit: expect.any(Function),
        orgId: "org-1",
      });
      expect(ensureRepoClone.mock.calls[0]?.[4]).toEqual({
        useGithubCredential: true,
      });
      const provider = await import("../../sandboxes/provider");
      expect(typeof provider.sandboxTemplate).toBe("function");
    } finally {
      await db.delete(runs).where(eq(runs.id, runId));
    }
  });
});

function sandboxHandle(): SandboxHandle {
  return {
    id: "sandbox-1",
    cpu: 2,
    memory: 4096,
    process: {
      executeCommand,
      createSession: async () => undefined,
      deleteSession: async () => undefined,
      getSession: async () => ({ commands: [] }),
      executeSessionCommand: async () => ({ cmdId: "cmd-1" }),
      getSessionCommandLogs: async () => ({}),
      createPty: async () => ({
        waitForConnection: async () => undefined,
        sendInput: async () => undefined,
        resize: async () => undefined,
        disconnect: async () => undefined,
        kill: async () => undefined,
      }),
    },
    fs: {
      getFileDetails: async () => ({}),
      downloadFile: async () => Buffer.from(""),
      uploadFile: async () => undefined,
    },
    start: async () => undefined,
    delete: async () => undefined,
    getPreviewLink: async () => ({ url: "https://sandbox.example" }),
  };
}
