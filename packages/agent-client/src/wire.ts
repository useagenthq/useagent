/**
 * The run/step WIRE CONTRACT — the exact snake_case shapes the Skynet backend
 * serializes (`backend/src/runs/repo.ts` `toRun`/`toStep`) and every client reads.
 *
 * ONE definition so the backend serializer and the React UI cannot drift: the
 * backend `satisfies` these types at its serializer return sites, `db/schema.ts`
 * derives its column unions from them, and the UI imports them instead of
 * hand-copying. Types only + two accepted-set consts + one tiny pure parser; no
 * runtime deps, no React/Node/provider imports. Packages never import apps, so
 * this is the ground-truth home the backend consumes.
 */

// ── Accepted sets at every API boundary ──────────────────────────────────────

export type RunStatus = "queued" | "running" | "completed" | "failed";
export type StepKind = "command" | "file" | "task" | "done";

/** Which team-memory pool a run reads/writes (default "org"). */
export const MEMORY_SCOPES = ["org", "personal"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/**
 * Which harness executes a run. `mock` is the scripted trace; `chat` is the
 * no-sandbox conversational path; the agent engines (opencode / claude / codex)
 * execute inside the per-thread sandbox. `daytona` / `claude-sdk` are legacy ids
 * kept so pre-consolidation rows still resolve (aliased in the registry); `acp`
 * is the hidden ACP bridge. THE single source of truth for the `EngineId` union —
 * `db/schema.ts` and the frontend engine picker both derive from this const.
 */
export const ENGINE_IDS = [
  "mock",
  "opencode",
  "claude",
  "codex",
  "chat",
  "daytona",
  "claude-sdk",
  "acp",
] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

// ── Leaf wire shapes referenced by ApiRun ────────────────────────────────────

/** A run's per-repo target: clean "owner/name" + the chosen branch (null = the
 *  repo's default branch). The stored ":branch" encoding never reaches the wire. */
export interface RepoRef {
  /** "owner/name". */
  repo: string;
  /** Explicit branch to clone, or null for the repo's default branch. */
  branch: string | null;
}

/** Where a resource came from and how it was authorized. */
export type RunIntakeSource = "web" | "api" | "slack" | "automation";

export type ResourceKind = "code.repository" | "code.change" | "file" | "web.page";

export type ResourceCapability =
  | "content.read"
  | "code.checkout"
  | "change.read"
  | "change.checks.read"
  | "deployment.read"
  | "file.read"
  | "page.read";

export interface ResourceProvenance {
  readonly source: "explicit" | "user_text" | "legacy_parent";
  readonly channel: RunIntakeSource;
  readonly raw: string;
  readonly start: number | null;
  readonly end: number | null;
}

export interface GitHubRepositoryLocator {
  readonly type: "github.repository";
  readonly repository: string;
  readonly revision: string | null;
}

export interface GitHubPullRequestLocator {
  readonly type: "github.pull_request";
  readonly repository: string;
  readonly number: number;
  readonly revision: string | null;
}

export interface FileLocator {
  readonly type: "file";
  readonly id: string;
  readonly name: string | null;
}

export interface WebPageLocator {
  readonly type: "web.page";
  readonly url: string;
}

interface RunResourceBase {
  readonly provider: string;
  readonly capabilities: readonly ResourceCapability[];
  readonly provenance: readonly ResourceProvenance[];
}

export interface GitHubRepositoryResource extends RunResourceBase {
  readonly kind: "code.repository";
  readonly provider: "github";
  readonly locator: GitHubRepositoryLocator;
}

export interface GitHubPullRequestResource extends RunResourceBase {
  readonly kind: "code.change";
  readonly provider: "github";
  readonly locator: GitHubPullRequestLocator;
}

export interface FileResource extends RunResourceBase {
  readonly kind: "file";
  readonly locator: FileLocator;
}

export interface WebPageResource extends RunResourceBase {
  readonly kind: "web.page";
  readonly locator: WebPageLocator;
}

/** Typed resources accepted for a run and serialized as `resolved_resources`. */
export type RunResource =
  | GitHubRepositoryResource
  | GitHubPullRequestResource
  | FileResource
  | WebPageResource;

/** One inbound attachment on a run's user turn (Slack files or a browser upload),
 *  serialized as `uploads`. Bytes come from `/api/uploads/:id/content`. */
export interface RunUpload {
  readonly id: string;
  readonly name: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly created_at: string;
}

// ── Runs + steps (GET /api/runs, GET /api/runs/:id?thread=1) ──────────────────

export interface ApiStep {
  id: string;
  run_id: string;
  idx: number;
  kind: StepKind;
  label: string;
  chip: string | null;
  code_json: string | null;
  created_at: string;
}

export interface ApiRun {
  id: string;
  org_id: string | null;
  user_id: string | null;
  prompt: string;
  model: string;
  engine: EngineId;
  status: RunStatus;
  summary: string | null;
  duration_ms: number | null;
  parent_run_id: string | null;
  /** True when this run is a GATEWAY CHILD SESSION - a deferred serial thread turn
   *  the parent agent spawned via child_session_create. The conversation folds
   *  these under the parent turn's subagent group instead of rendering a top-level
   *  user turn. `parent_run_id` alone cannot tell them apart - replies set it too. */
  child_session: boolean;
  thread_id: string;
  /** The engine's own native session id (opencode `ses_*`), when one was recorded.
   *  The thread's latest non-null value deep-links the Live tab into that session. */
  engine_session_id: string | null;
  /** Legacy single-repo mirror (= repos[0] ?? null), clean "owner/name". */
  repo: string | null;
  /** GitHub repos this thread works in (each clean "owner/name"); [] = bare workdir.
   *  Any per-repo branch lives in `repo_specs`, not here. */
  repos: string[];
  /** Per-repo target the run actually clones: clean repo + chosen branch (null =
   *  default). Decoded from the stored refs so replay reports the SAME branch. */
  repo_specs: RepoRef[];
  /** Typed resources accepted for this run. [] for legacy runs/callers. */
  resolved_resources: RunResource[];
  /** Which team-memory pool this run reads/writes (default "org"). */
  memory_scope: MemoryScope;
  /** Pinned skill revision this run loaded (null when none). Immutable: links a
   *  historical run to the EXACT skill version/hash it used. */
  skill_id: string | null;
  skill_version: number | null;
  skill_content_hash: string | null;
  /** Inbound attachments the user sent with this turn, claimed by the run. [] =
   *  none. Rendered on the user's bubble; bytes via `/api/uploads/:id/content`. */
  uploads: RunUpload[];
  created_at: string;
  updated_at: string;
  steps: ApiStep[];
}

/** Compact projection for navigation/dashboard surfaces (`listRunSummaries`).
 *  Heavy steps, uploads, resources, and provider session state stay off it. */
export type ApiRunSummary = Pick<
  ApiRun,
  | "id"
  | "prompt"
  | "model"
  | "engine"
  | "status"
  | "summary"
  | "duration_ms"
  | "repo"
  | "repos"
  | "repo_specs"
  | "created_at"
  | "updated_at"
>;

// ── Native-event lane (event: native on GET /api/runs/:id/events) ─────────────

/** Wire schema version for {@link NativeFrame}. Bumped on the backend when the
 *  frame shape changes; older frames upcast, newer parse best-effort (additive). */
export const NATIVE_SCHEMA_VERSION = 1;

export interface NativeFrameIds {
  readonly sessionId: string | null;
  readonly parentSessionId: string | null;
  readonly messageId: string | null;
  readonly partId: string | null;
  readonly callId: string | null;
}

/** A versioned native-event frame. `eventId` is the stable dedupe key (one per
 *  native part / lifecycle row); `seq` is the monotonic per-run cursor. A part
 *  revision re-emits the SAME `eventId` with a HIGHER `seq` — consumers key by
 *  `eventId` and keep the largest `seq`. `payload` is bounded and may be an
 *  `{ _unparseable, _bytes }` marker for over-cap capture, so treat it as unknown. */
export interface NativeFrame {
  readonly schemaVersion: number;
  readonly eventId: string;
  readonly seq: number;
  readonly provider: string;
  readonly eventType: string;
  readonly native: NativeFrameIds;
  readonly payload: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const readString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Parse an SSE `native` frame payload into a {@link NativeFrame}, or null if it is
 * malformed. A missing/invalid `schemaVersion` is treated as v1; a newer version
 * is accepted best-effort (fields are additive). `eventId`/`seq`/`eventType` are
 * required; a missing `provider` defaults to "opencode".
 */
export function parseNativeFrame(raw: unknown): NativeFrame | null {
  const o = asRecord(raw);
  if (!o) return null;
  const eventId = readString(o.eventId);
  const eventType = readString(o.eventType);
  const seq = typeof o.seq === "number" ? o.seq : null;
  if (eventId === null || eventType === null || seq === null) return null;

  const native = asRecord(o.native);
  const schemaVersion =
    typeof o.schemaVersion === "number" ? o.schemaVersion : NATIVE_SCHEMA_VERSION;
  return {
    schemaVersion,
    eventId,
    seq,
    provider: readString(o.provider) ?? "opencode",
    eventType,
    native: {
      sessionId: native ? readString(native.sessionId) : null,
      parentSessionId: native ? readString(native.parentSessionId) : null,
      messageId: native ? readString(native.messageId) : null,
      partId: native ? readString(native.partId) : null,
      callId: native ? readString(native.callId) : null,
    },
    payload: o.payload,
  };
}

// ── Session command catalog (native "/" commands) ────────────────────────────

/** One entry in a native session's slash-command catalog, normalized across
 *  engines (opencode's /command and ACP's available_commands_update). `input` is
 *  an optional argument hint. */
export interface CommandCatalogEntry {
  readonly name: string;
  readonly description?: string | null;
  readonly input?: string | null;
}

/** The authoritative command catalog for a specific native session, read from the
 *  durable canonical stream. `commands` is [] when the session advertised none;
 *  `revision` is the latest `commands.updated` deliverySeq (the catalog snapshot
 *  id) a native-command intent is authorized against. */
export interface SessionCommandCatalog {
  readonly commands: readonly CommandCatalogEntry[];
  readonly revision: number;
}
