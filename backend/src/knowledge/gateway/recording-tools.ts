import { basename } from "node:path";
import { publishSandboxArtifact } from "../../artifacts/publish";
import type { ArtifactDescriptor } from "../../artifacts/repo";
import { ensureSandboxDesktopView, type SandboxDesktop } from "../../engines/desktop";
import { getRunForOrg } from "../../runs/repo";
import {
  sandboxProvider,
  sandboxProviderApiKey,
  type SandboxHandle,
} from "../../sandboxes/provider";
import type { ToolTokenClaims } from "./token";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface RecordingMetadata {
  readonly path: string;
  readonly codec: "h264";
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
}

interface RecordingStopResult {
  readonly recording: RecordingMetadata;
  readonly artifact: ArtifactDescriptor;
  readonly created: boolean;
}

interface RecordingService {
  start(claims: ToolTokenClaims, name: string): Promise<{ path: string }>;
  stop(claims: ToolTokenClaims): Promise<RecordingStopResult>;
}

type DesktopReadiness = (
  sandbox: SandboxHandle,
  signal: AbortSignal,
) => Promise<SandboxDesktop>;

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const RECORDING_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const PATH_MARKER = "__SKYNET_RECORDING_PATH__=";
const DAYTONA_RECORDING_STATE = "/home/daytona/.skynet/active-recording-id";

const result = (text: string, structuredContent?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
});

const failure = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

function checkedName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || !NAME_RE.test(name)) {
    throw new Error("recording name may contain only letters, numbers, dot, underscore, and dash");
  }
  return name;
}

async function recordingSandbox(claims: ToolTokenClaims): Promise<SandboxHandle> {
  const run = await getRunForOrg(claims.orgId, claims.runId);
  if (!run || run.threadId !== claims.threadId) throw new Error("run not found in this thread");
  if (!run.sandboxId) throw new Error("no sandbox is attached to this run");
  const apiKey = sandboxProviderApiKey();
  if (apiKey === undefined) throw new Error("sandbox provider credentials are not set");
  return await sandboxProvider(apiKey).get(run.sandboxId);
}

export async function startRecordingInSandbox(
  sandbox: SandboxHandle,
  name: string,
  signal: AbortSignal,
  ensureDesktop: DesktopReadiness = ensureSandboxDesktopView,
): Promise<string> {
  const recordingName = checkedName(name);
  if (sandbox.computerUse) {
    await sandbox.computerUse.start();
    const recording = await sandbox.computerUse.recording.start(recordingName);
    if (!RECORDING_ID_RE.test(recording.id) || !recording.filePath.endsWith(".mp4")) {
      throw new Error("Daytona returned invalid recording metadata");
    }
    const encodedId = Buffer.from(recording.id, "utf8").toString("base64");
    const persisted = await sandbox.process.executeCommand(
      `install -d '/home/daytona/.skynet' && printf '%s' '${encodedId}' | base64 -d > '${DAYTONA_RECORDING_STATE}'`,
      undefined,
      undefined,
      30,
    );
    if ((persisted.exitCode ?? 1) !== 0) {
      throw new Error((persisted.result ?? "could not persist Daytona recording state").trim());
    }
    return recording.filePath;
  }
  const desktop = await ensureDesktop(sandbox, signal);
  if (!desktop.available) {
    throw new Error(desktop.reason ?? "desktop failed readiness");
  }
  const started = await sandbox.process.executeCommand(
    `skynet-record-start '${recordingName}'`,
    undefined,
    undefined,
    60,
  );
  const path = (started.result ?? "").trim().split("\n").at(-1)?.trim() ?? "";
  if ((started.exitCode ?? 1) !== 0 || !path.endsWith(`/${recordingName}.mp4`)) {
    throw new Error((started.result ?? "recording failed to start").trim());
  }
  return path;
}

export async function stopRecordingInSandbox(
  sandbox: SandboxHandle,
): Promise<RecordingMetadata> {
  if (sandbox.computerUse) {
    const state = await sandbox.process.executeCommand(
      `test -f '${DAYTONA_RECORDING_STATE}' && cat '${DAYTONA_RECORDING_STATE}'`,
      undefined,
      undefined,
      30,
    );
    const recordingId = (state.result ?? "").trim();
    if ((state.exitCode ?? 1) !== 0 || !RECORDING_ID_RE.test(recordingId)) {
      throw new Error("no active Daytona recording was found");
    }
    const stopped = await sandbox.computerUse.recording.stop(recordingId);
    const durationSeconds = stopped.durationSeconds ?? 0;
    const details = await sandbox.fs.getFileDetails(stopped.filePath);
    const displays = (await sandbox.computerUse.display.getInfo()).displays ?? [];
    const activeDisplay = displays.find((display) => display.isActive) ?? displays[0];
    const width = activeDisplay?.width ?? 0;
    const height = activeDisplay?.height ?? 0;
    if (
      !stopped.filePath.endsWith(".mp4") ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      !Number.isInteger(width) ||
      width <= 0 ||
      !Number.isInteger(height) ||
      height <= 0 ||
      !Number.isFinite(details.size) ||
      (details.size ?? 0) <= 0
    ) {
      throw new Error("finished Daytona recording failed metadata validation");
    }
    await sandbox.process.executeCommand(
      `rm -f '${DAYTONA_RECORDING_STATE}'`,
      undefined,
      undefined,
      30,
    );
    return { path: stopped.filePath, codec: "h264", width, height, durationSeconds };
  }
  const stopped = await sandbox.process.executeCommand(
    "path=$(skynet-record-stop) || exit $?; " +
      `printf '${PATH_MARKER}%s\\n' \"$path\"; ` +
      "ffprobe -v error -select_streams v:0 " +
      "-show_entries stream=codec_name,width,height -show_entries format=duration " +
      "-of default=noprint_wrappers=1 \"$path\"",
    undefined,
    undefined,
    60,
  );
  const output = stopped.result ?? "";
  if ((stopped.exitCode ?? 1) !== 0) {
    throw new Error(output.trim() || "recording failed to stop");
  }
  const value = (key: string): string =>
    new RegExp(`^${key}=(.+)$`, "m").exec(output)?.[1]?.trim() ?? "";
  const path = value(PATH_MARKER.slice(0, -1));
  const codec = value("codec_name");
  const width = Number(value("width"));
  const height = Number(value("height"));
  const durationSeconds = Number(value("duration"));
  if (
    !path.endsWith(".mp4") ||
    codec !== "h264" ||
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new Error("finished recording failed ffprobe validation");
  }
  return { path, codec, width, height, durationSeconds };
}

const productionService: RecordingService = {
  async start(claims, name) {
    const sandbox = await recordingSandbox(claims);
    return {
      path: await startRecordingInSandbox(
        sandbox,
        name,
        AbortSignal.timeout(60_000),
      ),
    };
  },
  async stop(claims) {
    const sandbox = await recordingSandbox(claims);
    const recording = await stopRecordingInSandbox(sandbox);
    const published = await publishSandboxArtifact({
      orgId: claims.orgId,
      userId: claims.userId || null,
      runId: claims.runId,
      threadId: claims.threadId,
      path: recording.path,
      name: basename(recording.path),
    });
    return {
      recording,
      artifact: published.artifact,
      created: published.created,
    };
  },
};

let serviceOverride: RecordingService | null = null;

/** Test-only seam: production always uses the provider-backed service above. */
export function setRecordingServiceForTest(service: RecordingService | null): void {
  serviceOverride = service;
}

export const RECORDING_TOOLS = [
  {
    name: "desktop_recording_start",
    description:
      "Start recording the sandbox desktop. Daytona uses its native Computer Use recorder; Cube " +
      "uses its preinstalled FFmpeg/X11 recorder. Use it before computer actions " +
      "when the user asks for a video.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Optional safe recording basename without .mp4.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "desktop_recording_stop",
    description:
      "Stop the active provider-native desktop recording, validate the MP4, and publish it as " +
      "a durable authenticated Skynet artifact. Returns working preview and download URLs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

export const RECORDING_TOOL_NAMES: ReadonlySet<string> = new Set(
  RECORDING_TOOLS.map((tool) => tool.name),
);

export async function executeRecordingTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const service = serviceOverride ?? productionService;
  try {
    if (name === "desktop_recording_start") {
      const requested = typeof args.name === "string" && args.name.trim()
        ? args.name.trim().replace(/\.mp4$/i, "")
        : `recording-${Date.now()}`;
      const started = await service.start(claims, checkedName(requested));
      return result(`Recording started: ${started.path}`, { recording: started });
    }
    if (name === "desktop_recording_stop") {
      const stopped = await service.stop(claims);
      return result(
        `Recording complete: [${stopped.artifact.name}](${stopped.artifact.preview_url}) ` +
          `(${stopped.recording.codec}, ${stopped.recording.width}x${stopped.recording.height}, ` +
          `${stopped.recording.durationSeconds.toFixed(2)}s). ` +
          `[Download](${stopped.artifact.download_url})`,
        {
          recording: stopped.recording,
          artifact: stopped.artifact,
          created: stopped.created,
        },
      );
    }
    return failure(`Unknown tool: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "desktop recording failed";
    return failure(`Could not ${name === "desktop_recording_stop" ? "stop" : "start"} recording: ${message}`);
  }
}
