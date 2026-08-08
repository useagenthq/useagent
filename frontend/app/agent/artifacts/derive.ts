/**
 * Live Artifacts derivation.
 *
 * The backend has no artifact concept — artifacts are the *file outputs* of a
 * run. This module turns `GET /api/runs` into a flat, newest-first list of
 * artifact cards: every step with `kind === "file"` becomes one artifact whose
 * filename, size, and folder lane are synthesized deterministically from the
 * run + step ids (so re-fetches never reshuffle names or sizes). Framework-free
 * (no JSX) so both the client view and card can share the types + formatters.
 *
 * PLACEHOLDER, not durable storage: there is no real artifact backend. The future
 * durable-artifact architecture (ArtifactDescriptor, out-of-band bytes, renderer
 * registry, native-file vs sandboxed-app lanes) is a documented contract in
 * `packages/agent-client/ARTIFACTS.md` - none of it is built here.
 */

export type ArtifactCategory = "code" | "docs" | "media";

/** Wire shapes we read from the backend list endpoint. Only the fields this
 * surface needs — steps carry `created_at` on the wire even though the run-trace
 * types omit it. */
interface BackendStep {
  id?: string;
  idx: number;
  kind: "command" | "file" | "task" | "done";
  created_at?: string | number;
}

export interface BackendRun {
  id: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed";
  created_at: string | number;
  steps: BackendStep[];
}

export interface Artifact {
  /** Stable key — the originating step id. */
  id: string;
  name: string;
  ext: string;
  category: ArtifactCategory;
  /** Workspace lane the run belongs to (the floating folder chip). */
  lane: string;
  /** Pre-formatted "1.3 MB" / "974.2 KB". */
  size: string;
  /** Pre-formatted "7/19/2026". */
  date: string;
  runId: string;
  runPrompt: string;
  /** Newest file of a still-running run — renders a pulsing LIVE chip. */
  live: boolean;
  /** Epoch ms of the step, for newest-first ordering. */
  sortTime: number;
}

/** The list endpoint ships a `{ runs: [...] }` envelope; the API contract also
 * allows a bare array. Accept both, anything else → null. */
export function extractRuns(data: unknown): BackendRun[] | null {
  if (Array.isArray(data)) return data as BackendRun[];
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { runs?: unknown }).runs)
  ) {
    return (data as { runs: BackendRun[] }).runs;
  }
  return null;
}

/** FNV-1a — small, stable string hash for deterministic pseudo values. */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Workspace lanes — mirrors the AgentSidebar "Workspace" section. A run is
 * pinned to one lane by its id so its artifacts share a folder chip. */
const LANES = [
  "Growth Operator",
  "Content Pipeline",
  "Workflow Engine",
  "Research Cluster",
] as const;

/** Round-robin file types so a run's three file steps read as a code file, a
 * doc, and an image — matching the All / Files / Docs / Media filters. */
const EXT_ROTATION = [".tsx", ".md", ".png"] as const;

function slugify(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  return words || "artifact";
}

function categoryForExt(ext: string): ArtifactCategory {
  if (ext === ".md") return "docs";
  if (ext === ".png") return "media";
  return "code";
}

/** Deterministic 80 KB – 3.2 MB, formatted like the reference (KB/MB, 1 dp). */
function pseudoSize(seed: string): string {
  const bytes = 80_000 + (hash(seed) % 3_120_000);
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${(bytes / 1000).toFixed(1)} KB`;
}

function formatDate(value: string | number): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US");
}

function toTime(value: string | number): number {
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Flatten runs → newest-first artifacts. Runs with no file steps drop out. */
export function deriveArtifacts(runs: BackendRun[]): Artifact[] {
  const artifacts: Artifact[] = [];

  for (const run of runs) {
    const fileSteps = run.steps
      .filter((s) => s.kind === "file")
      .sort((a, b) => a.idx - b.idx);
    if (fileSteps.length === 0) continue;

    const lane = LANES[hash(run.id) % LANES.length];
    const newestIdx = fileSteps[fileSteps.length - 1].idx;

    fileSteps.forEach((step, fileIndex) => {
      const ext = EXT_ROTATION[fileIndex % EXT_ROTATION.length];
      const id = step.id ?? `${run.id}-${step.idx}`;
      const when = step.created_at ?? run.created_at;
      artifacts.push({
        id,
        name: `${slugify(run.prompt)}-${fileIndex + 1}${ext}`,
        ext,
        category: categoryForExt(ext),
        lane,
        size: pseudoSize(id),
        date: formatDate(when),
        runId: run.id,
        runPrompt: run.prompt,
        live: run.status === "running" && step.idx === newestIdx,
        sortTime: toTime(when),
      });
    });
  }

  return artifacts.sort((a, b) => b.sortTime - a.sortTime);
}
