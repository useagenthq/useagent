import { enrolRunner } from "./runner-api";
import type { RunnerPlatform } from "./runner-data";

export interface DesktopRunnerStatus {
  readonly state: "starting" | "pulling" | "online" | "offline" | "error";
  readonly detail?: string;
  readonly progress?: number;
}

export interface UseAgentDesktopBridge {
  readonly version: string;
  readonly platform: "darwin" | "win32" | "linux";
  connectRunner(token: string): Promise<void>;
  runnerStatus(): Promise<DesktopRunnerStatus>;
  openExternal(url: string): void;
}

interface UserAgentData {
  getHighEntropyValues(hints: string[]): Promise<{ architecture?: string; bitness?: string }>;
}

export function desktopBridge(): UseAgentDesktopBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { useagentDesktop?: UseAgentDesktopBridge }).useagentDesktop ?? null;
}

/** The desktop shell ships a local runner on macOS only. Other desktops are cloud clients. */
export function localRunnerAvailable(platform: UseAgentDesktopBridge["platform"]): boolean {
  return platform === "darwin";
}

export async function resolveRunnerPlatform(
  platform: UseAgentDesktopBridge["platform"],
  userAgentData: UserAgentData | undefined = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData,
): Promise<RunnerPlatform | null> {
  if (!userAgentData) return null;
  try {
    const { architecture, bitness } = await userAgentData.getHighEntropyValues([
      "architecture",
      "bitness",
    ]);
    const arch = architecture?.toLowerCase();
    const qualifiedArch =
      (arch === "arm" || arch === "arm64" || arch === "aarch64") && bitness === "64"
        ? "arm64"
        : (arch === "x86" || arch === "x86_64" || arch === "amd64") && bitness === "64"
          ? "x64"
          : null;
    if (!qualifiedArch || (platform === "win32" && qualifiedArch !== "x64")) return null;
    return `${platform}-${qualifiedArch}` as RunnerPlatform;
  } catch {
    return null;
  }
}

export function machineLabel(platform: UseAgentDesktopBridge["platform"]): string {
  if (platform === "darwin") return "This Mac";
  if (platform === "win32") return "This Windows PC";
  return "This Linux machine";
}

export function runnerConnectionAction(
  status: DesktopRunnerStatus | null,
  platform: UseAgentDesktopBridge["platform"],
): { active: boolean; label: string } {
  if (!status) return { active: true, label: "Checking runner" };
  return {
    active:
      status?.state === "starting" || status?.state === "pulling" || status?.state === "online",
    label:
      status?.state === "online"
        ? "Connected"
        : `Connect this ${platform === "darwin" ? "Mac" : "machine"}`,
  };
}

export async function connectDesktopRunner(
  bridge: UseAgentDesktopBridge,
  platform: RunnerPlatform,
  enrol: typeof enrolRunner = enrolRunner,
): Promise<void> {
  const { token } = await enrol({ name: machineLabel(bridge.platform), platform });
  await bridge.connectRunner(token);
}
