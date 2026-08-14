import { afterEach, describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../../sandboxes/provider";
import {
  executeRecordingTool,
  RECORDING_TOOLS,
  setRecordingServiceForTest,
  startRecordingInSandbox,
  stopRecordingInSandbox,
} from "./recording-tools";
import type { ToolTokenClaims } from "./token";

const claims: ToolTokenClaims = {
  orgId: "org-1",
  userId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  scope: "run",
  exp: Date.now() + 60_000,
};

function sandboxWithResult(result: string, exitCode = 0): SandboxHandle {
  return {
    id: "sandbox-1",
    cpu: 2,
    memory: 8,
    labels: {},
    state: "started",
    start: async () => {},
    delete: async () => {},
    getPreviewLink: async () => ({ url: "http://sandbox" }),
    fs: {
      getFileDetails: async () => ({ size: 1 }),
      downloadFile: async () => Buffer.from("x"),
      uploadFile: async () => {},
    },
    process: {
      executeCommand: async () => ({ exitCode, result }),
      createSession: async () => {},
      deleteSession: async () => {},
      getSession: async () => ({ commands: [] }),
      executeSessionCommand: async () => ({ cmdId: "cmd-1" }),
      getSessionCommandLogs: async () => ({ output: "", stdout: "", stderr: "" }),
      createPty: async () => ({
        waitForConnection: async () => {},
        sendInput: async () => {},
        resize: async () => {},
        disconnect: async () => {},
        kill: async () => {},
      }),
    },
  };
}

afterEach(() => setRecordingServiceForTest(null));

describe("recording gateway tools", () => {
  test("advertises explicit start and stop tools", () => {
    expect(RECORDING_TOOLS.map((tool) => tool.name)).toEqual([
      "desktop_recording_start",
      "desktop_recording_stop",
    ]);
  });

  test("starts only after the desktop is ready and returns the sandbox path", async () => {
    const commands: string[] = [];
    const sandbox = sandboxWithResult("/root/work/recordings/proof.mp4\n");
    sandbox.process.executeCommand = async (command) => {
      commands.push(command);
      return { exitCode: 0, result: "/root/work/recordings/proof.mp4\n" };
    };

    const path = await startRecordingInSandbox(
      sandbox,
      "proof",
      AbortSignal.timeout(1_000),
      async () => ({
        available: true,
        browserTools: true,
        home: "/root",
        workdir: "/root/work",
        browserExecutable: "/usr/bin/chromium",
      }),
    );

    expect(path).toBe("/root/work/recordings/proof.mp4");
    expect(commands).toEqual(["skynet-record-start 'proof'"]);
  });

  test("refuses to start when desktop readiness cannot be established", async () => {
    const sandbox = sandboxWithResult("");
    await expect(
      startRecordingInSandbox(
        sandbox,
        "proof",
        AbortSignal.timeout(1_000),
        async () => ({
          available: false,
          browserTools: false,
          home: "/root",
          workdir: "/root/work",
          browserExecutable: null,
          reason: "display failed readiness",
        }),
      ),
    ).rejects.toThrow("display failed readiness");
  });

  test("uses Daytona native recording and persists its active recording id", async () => {
    const commands: string[] = [];
    const sandbox = sandboxWithResult("");
    sandbox.process.executeCommand = async (command) => {
      commands.push(command);
      return { exitCode: 0, result: "" };
    };
    Object.defineProperty(sandbox, "computerUse", { value: {
      start: async () => ({ message: "started" }),
      recording: {
        start: async () => ({
          id: "recording-1",
          fileName: "proof.mp4",
          filePath: "/home/daytona/.daytona/recordings/proof.mp4",
          startTime: "2026-08-12T00:00:00Z",
          status: "recording",
        }),
      },
    } as unknown as SandboxHandle["computerUse"] });

    const path = await startRecordingInSandbox(
      sandbox,
      "proof",
      AbortSignal.timeout(1_000),
      async () => {
        throw new Error("Cube readiness must not run for Daytona");
      },
    );

    expect(path).toBe("/home/daytona/.daytona/recordings/proof.mp4");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("active-recording-id");
  });

  test("stops and validates a real H.264 recording before publishing", async () => {
    const sandbox = sandboxWithResult(
      "__SKYNET_RECORDING_PATH__=/root/work/recordings/proof.mp4\ncodec_name=h264\nwidth=1440\nheight=900\nduration=2.200000\n",
    );
    const stopped = await stopRecordingInSandbox(sandbox);
    expect(stopped).toEqual({
      path: "/root/work/recordings/proof.mp4",
      codec: "h264",
      width: 1440,
      height: 900,
      durationSeconds: 2.2,
    });
  });

  test("stops Daytona native recording and validates provider metadata", async () => {
    const commands: string[] = [];
    const sandbox = sandboxWithResult("recording-1\n");
    sandbox.process.executeCommand = async (command) => {
      commands.push(command);
      return { exitCode: 0, result: command.includes("cat") ? "recording-1\n" : "" };
    };
    sandbox.fs.getFileDetails = async () => ({ size: 1_024 });
    Object.defineProperty(sandbox, "computerUse", { value: {
      recording: {
        stop: async (id: string) => ({
          id,
          fileName: "proof.mp4",
          filePath: "/home/daytona/.daytona/recordings/proof.mp4",
          startTime: "2026-08-12T00:00:00Z",
          endTime: "2026-08-12T00:00:02Z",
          durationSeconds: 2.2,
          sizeBytes: 1_024,
          status: "completed",
        }),
      },
      display: {
        getInfo: async () => ({ displays: [{ width: 1440, height: 900, isActive: true }] }),
      },
    } as unknown as SandboxHandle["computerUse"] });

    await expect(stopRecordingInSandbox(sandbox)).resolves.toEqual({
      path: "/home/daytona/.daytona/recordings/proof.mp4",
      codec: "h264",
      width: 1440,
      height: 900,
      durationSeconds: 2.2,
    });
    expect(commands.at(-1)).toContain("rm -f");
  });

  test("returns a durable authenticated artifact reference from stop", async () => {
    setRecordingServiceForTest({
      start: async () => ({ path: "/root/work/recordings/proof.mp4" }),
      stop: async () => ({
        recording: {
          path: "/root/work/recordings/proof.mp4",
          codec: "h264",
          width: 1440,
          height: 900,
          durationSeconds: 2.2,
        },
        artifact: {
          id: "artifact-1",
          run_id: "run-1",
          thread_id: "thread-1",
          name: "proof.mp4",
          source_path: "/root/work/recordings/proof.mp4",
          content_type: "video/mp4",
          size_bytes: 1234,
          sha256: "abc",
          preview_url: "/api/artifacts/artifact-1/content",
          download_url: "/api/artifacts/artifact-1/content?download=1",
          created_at: "2026-08-12T00:00:00.000Z",
          workpiece: null,
        },
        created: true,
      }),
    });

    const response = await executeRecordingTool(claims, "desktop_recording_stop", {});
    expect(response.isError).toBeUndefined();
    expect(response.content[0]?.text).toContain("/api/artifacts/artifact-1/content");
    expect(response.structuredContent?.artifact).toMatchObject({ id: "artifact-1" });
  });
});
