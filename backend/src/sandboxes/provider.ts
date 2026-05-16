import { Daytona, type ComputerUse } from "@daytona/sdk";
import { cubeSandboxProvider } from "./cube-provider";

export type SandboxProviderKind = "daytona" | "cube";

export interface SandboxExecuteResult {
  result?: string;
  exitCode?: number;
}

export interface SandboxSession {
  commands: Array<{ id: string }>;
}

export interface SandboxPtyHandle {
  waitForConnection(): Promise<void>;
  sendInput(data: string | Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<unknown>;
  disconnect(): Promise<void>;
  kill(): Promise<unknown>;
}

export interface SandboxProcess {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeoutSeconds?: number,
  ): Promise<SandboxExecuteResult>;
  createSession(sessionId: string): Promise<unknown>;
  deleteSession(sessionId: string): Promise<unknown>;
  getSession(sessionId: string): Promise<SandboxSession>;
  executeSessionCommand(
    sessionId: string,
    request: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
    timeoutSeconds?: number,
  ): Promise<{ cmdId: string; output?: string; stdout?: string; stderr?: string; exitCode?: number }>;
  getSessionCommandLogs(
    sessionId: string,
    commandId: string,
  ): Promise<{ output?: string; stdout?: string; stderr?: string }>;
  createPty(options: {
    id: string;
    cols: number;
    rows: number;
    cwd?: string;
    envs?: Record<string, string>;
    onData: (data: Uint8Array) => void | Promise<void>;
  }): Promise<SandboxPtyHandle>;
}

export interface SandboxFileSystem {
  getFileDetails(path: string): Promise<{ size?: number }>;
  downloadFile(path: string): Promise<Buffer>;
  uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void>;
}

export interface SandboxHandle {
  readonly id: string;
  readonly cpu: number;
  readonly memory: number;
  state?: string;
  labels?: Record<string, string>;
  readonly process: SandboxProcess;
  readonly fs: SandboxFileSystem;
  /** Daytona exposes this natively. Cube intentionally omits it and the trusted
   * gateway drives the sandbox's X11 workstation with xdotool instead. */
  readonly computerUse?: ComputerUse;
  start(): Promise<void>;
  delete(): Promise<void>;
  getPreviewLink(port: number): Promise<{ url: string; token?: string }>;
}

export interface SandboxCreateOptions {
  snapshot?: string;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
}

export interface SandboxProvider {
  create(options?: SandboxCreateOptions): Promise<SandboxHandle>;
  get(sandboxId: string): Promise<SandboxHandle>;
  list(): AsyncIterable<SandboxHandle>;
}

export function sandboxProviderKind(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SandboxProviderKind {
  const value = env.SANDBOX_PROVIDER?.trim().toLowerCase() || "daytona";
  if (value !== "daytona" && value !== "cube") {
    throw new Error("SANDBOX_PROVIDER must be daytona or cube");
  }
  return value;
}

export function sandboxProviderApiKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (sandboxProviderKind(env) === "cube") {
    return env.CUBE_API_KEY?.trim() ?? "";
  }
  return env.DAYTONA_API_KEY?.trim() || undefined;
}

export function sandboxPreviewHeaders(token: string): Record<string, string> {
  if (!token) return {};
  return {
    "cube-traffic-access-token": token,
    "e2b-traffic-access-token": token,
    "x-daytona-preview-token": token,
  };
}

export function sandboxTemplate(
  daytonaEnvName: string,
  daytonaFallback: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (sandboxProviderKind(env) === "cube") {
    const template = env.CUBE_TEMPLATE_ID?.trim();
    if (!template) throw new Error("CUBE_TEMPLATE_ID is required when SANDBOX_PROVIDER=cube");
    return template;
  }
  return env[daytonaEnvName]?.trim() || daytonaFallback;
}

const daytonaTarget = (): string => process.env.DAYTONA_TARGET ?? "us";
const daytonaApiUrl = (): string =>
  process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api";

export function sandboxProvider(apiKey = sandboxProviderApiKey()): SandboxProvider {
  if (sandboxProviderKind() === "cube") return cubeSandboxProvider(apiKey ?? "");
  if (!apiKey) throw new Error("DAYTONA_API_KEY is required when SANDBOX_PROVIDER=daytona");
  return new Daytona({ apiKey, target: daytonaTarget() });
}

/** Backward-compatible name for external callers while the internal call sites migrate. */
export const daytonaProvider = sandboxProvider;

export interface DaytonaApiConfig {
  apiKey: string;
  apiUrl: string;
  target: string;
}

export function daytonaApiConfig(apiKey: string): DaytonaApiConfig {
  return { apiKey, apiUrl: daytonaApiUrl(), target: daytonaTarget() };
}
