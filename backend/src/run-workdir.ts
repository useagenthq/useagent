import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { RUN_TIMING_OUTCOMES } from "./runs/run-timing";

type InitializeGitBoundary = (workdir: string) => Promise<boolean>;

const initializeGitBoundary: InitializeGitBoundary = async (workdir) => {
  const exitCode = await Bun.spawn(["git", "init", "-q"], {
    cwd: workdir,
    stdout: "ignore",
    stderr: "ignore",
  }).exited.catch(() => null);
  return exitCode === 0;
};

async function hasGitBoundary(workdir: string): Promise<boolean> {
  try {
    const gitDirectory = await lstat(join(workdir, ".git"));
    if (!gitDirectory.isDirectory()) return false;
    return (await lstat(join(workdir, ".git", "HEAD"))).isFile();
  } catch {
    return false;
  }
}

/** Ensure the thread jail has a project boundary. Resumed turns avoid spawning
 * `git init` once the boundary already exists; initialization remains best-effort. */
export async function ensureRunWorkdir(
  workdir: string,
  initializeGit: InitializeGitBoundary = initializeGitBoundary,
): Promise<"hit" | "ready" | "unavailable"> {
  await mkdir(workdir, { recursive: true });
  if (await hasGitBoundary(workdir)) return RUN_TIMING_OUTCOMES.hit;
  try {
    if (!(await initializeGit(workdir))) return RUN_TIMING_OUTCOMES.unavailable;
    return (await hasGitBoundary(workdir))
      ? RUN_TIMING_OUTCOMES.ready
      : RUN_TIMING_OUTCOMES.unavailable;
  } catch {
    return RUN_TIMING_OUTCOMES.unavailable;
  }
}
