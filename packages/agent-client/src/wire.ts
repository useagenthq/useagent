/**
 * The run/step WIRE CONTRACT — the exact snake_case shapes the useAgent backend
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

export const RUN_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_KINDS = ["command", "file", "task", "done"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

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
  "pi",
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

export type ResourceKind = "code.repository" | "code.change" | "thread" | "file" | "web.page";

export type ResourceCapability =
  | "content.read"
  | "code.checkout"
  | "change.read"
  | "change.checks.read"
  | "deployment.read"
  | "thread.read"
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

export interface ThreadLocator {
  readonly type: "thread";
  readonly id: string;
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

export interface ThreadResource extends RunResourceBase {
  readonly kind: "thread";
  readonly provider: "useagent";
  readonly locator: ThreadLocator;
}

export interface WebPageResource extends RunResourceBase {
  readonly kind: "web.page";
  readonly locator: WebPageLocator;
}

/** Typed resources accepted for a run and serialized as `resolved_resources`. */
export type RunResource =
  | GitHubRepositoryResource
  | GitHubPullRequestResource
  | ThreadResource
  | FileResource
  | WebPageResource;

/** Client-selected resource identity. Capabilities, provenance, and mutable
 * provider revisions are always resolved by the server at run intake. */
export type RunResourceSelection =
  | Omit<GitHubRepositoryResource, "capabilities" | "provenance">
  | Omit<GitHubPullRequestResource, "capabilities" | "provenance">
  | Omit<ThreadResource, "capabilities" | "provenance">
  | Omit<FileResource, "capabilities" | "provenance">
  | Omit<WebPageResource, "capabilities" | "provenance">;

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
  /** Durable project identity. Null means an independent, unfiled thread. */
  project_id?: string | null;
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
  | "project_id"
  | "repo"
  | "repos"
  | "repo_specs"
  | "created_at"
  | "updated_at"
>;

/** One turn's skeleton in a thread outline (`GET /api/runs/:id/thread-outline`):
 *  just enough to order the thread and size a placeholder row - no prompt, no
 *  summary text, no step bodies. Powers windowed initial loading: the client
 *  renders unloaded turns from this and fetches full `ApiRun`s on demand. */
export interface ApiThreadOutlineTurn {
  id: string;
  status: RunStatus;
  /** Number of durable steps the run holds (feeds the placeholder height estimate). */
  step_count: number;
  /** Whether the run settled with a summary (an answer block will render). */
  has_summary: boolean;
  created_at: string;
}

// ── Run/step boundary decoders ──────────────────────────────────────────────

const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUSES);
const STEP_KIND_SET: ReadonlySet<string> = new Set(STEP_KINDS);
const ENGINE_ID_SET: ReadonlySet<string> = new Set(ENGINE_IDS);
const MEMORY_SCOPE_SET: ReadonlySet<string> = new Set(MEMORY_SCOPES);
const RESOURCE_CAPABILITY_SET: ReadonlySet<string> = new Set([
  "content.read",
  "code.checkout",
  "change.read",
  "change.checks.read",
  "deployment.read",
  "thread.read",
  "file.read",
  "page.read",
]);
const INTAKE_SOURCE_SET: ReadonlySet<string> = new Set(["web", "api", "slack", "automation"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function decodeRepoRef(value: unknown): RepoRef | null {
  const record = asRecord(value);
  if (!record || typeof record.repo !== "string" || !isNullableString(record.branch)) return null;
  return { repo: record.repo, branch: record.branch };
}

function decodeRunUpload(value: unknown): RunUpload | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.content_type !== "string" ||
    typeof record.size_bytes !== "number" ||
    typeof record.created_at !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    name: record.name,
    content_type: record.content_type,
    size_bytes: record.size_bytes,
    created_at: record.created_at,
  };
}

function isRunResource(value: unknown): value is RunResource {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.kind !== "string" ||
    typeof record.provider !== "string" ||
    !Array.isArray(record.capabilities) ||
    !record.capabilities.every(
      (item) => typeof item === "string" && RESOURCE_CAPABILITY_SET.has(item),
    ) ||
    !Array.isArray(record.provenance) ||
    !record.provenance.every((item) => {
      const provenance = asRecord(item);
      return (
        provenance !== null &&
        (provenance.source === "explicit" ||
          provenance.source === "user_text" ||
          provenance.source === "legacy_parent") &&
        typeof provenance.channel === "string" &&
        INTAKE_SOURCE_SET.has(provenance.channel) &&
        typeof provenance.raw === "string" &&
        (provenance.start === null || typeof provenance.start === "number") &&
        (provenance.end === null || typeof provenance.end === "number")
      );
    }) ||
    asRecord(record.locator) === null
  ) {
    return false;
  }
  const locator = record.locator as Record<string, unknown>;
  if (record.kind === "code.repository") {
    return (
      record.provider === "github" &&
      locator.type === "github.repository" &&
      typeof locator.repository === "string" &&
      isNullableString(locator.revision)
    );
  }
  if (record.kind === "code.change") {
    return (
      record.provider === "github" &&
      locator.type === "github.pull_request" &&
      typeof locator.repository === "string" &&
      typeof locator.number === "number" &&
      isNullableString(locator.revision)
    );
  }
  if (record.kind === "thread") {
    return record.provider === "useagent" && locator.type === "thread" && typeof locator.id === "string";
  }
  if (record.kind === "file") {
    return locator.type === "file" && typeof locator.id === "string" && isNullableString(locator.name);
  }
  return record.kind === "web.page" && locator.type === "web.page" && typeof locator.url === "string";
}

/** Decode one step at an untrusted HTTP/SSE boundary. Invalid enum values are
 * rejected rather than asserted into the shared contract. */
export function decodeApiStep(value: unknown): ApiStep | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.run_id !== "string" ||
    typeof record.idx !== "number" ||
    typeof record.kind !== "string" ||
    !STEP_KIND_SET.has(record.kind) ||
    typeof record.label !== "string" ||
    !isNullableString(record.chip) ||
    !isNullableString(record.code_json) ||
    typeof record.created_at !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    run_id: record.run_id,
    idx: record.idx,
    kind: record.kind as StepKind,
    label: record.label,
    chip: record.chip,
    code_json: record.code_json,
    created_at: record.created_at,
  };
}

/** Decode the compact run projection used by navigation/dashboard surfaces. */
export function decodeApiRunSummary(value: unknown): ApiRunSummary | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.prompt !== "string" ||
    typeof record.model !== "string" ||
    typeof record.engine !== "string" ||
    !ENGINE_ID_SET.has(record.engine) ||
    typeof record.status !== "string" ||
    !RUN_STATUS_SET.has(record.status) ||
    !isNullableString(record.summary) ||
    !(record.duration_ms === null || typeof record.duration_ms === "number") ||
    !(record.project_id === undefined || isNullableString(record.project_id)) ||
    !isNullableString(record.repo) ||
    !isStringArray(record.repos) ||
    !Array.isArray(record.repo_specs) ||
    typeof record.created_at !== "string" ||
    typeof record.updated_at !== "string"
  ) {
    return null;
  }
  const repoSpecs = record.repo_specs.map(decodeRepoRef);
  if (repoSpecs.some((item) => item === null)) return null;
  return {
    id: record.id,
    prompt: record.prompt,
    model: record.model,
    engine: record.engine as EngineId,
    status: record.status as RunStatus,
    summary: record.summary,
    duration_ms: record.duration_ms,
    project_id: record.project_id ?? null,
    repo: record.repo,
    repos: record.repos,
    repo_specs: repoSpecs as RepoRef[],
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/** Decode one thread-outline turn skeleton at an untrusted HTTP boundary. */
export function decodeThreadOutlineTurn(value: unknown): ApiThreadOutlineTurn | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.status !== "string" ||
    !RUN_STATUS_SET.has(record.status) ||
    typeof record.step_count !== "number" ||
    typeof record.has_summary !== "boolean" ||
    typeof record.created_at !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    status: record.status as RunStatus,
    step_count: record.step_count,
    has_summary: record.has_summary,
    created_at: record.created_at,
  };
}

/** Decode a full run row at an untrusted HTTP/SSE boundary. */
export function decodeApiRun(value: unknown): ApiRun | null {
  const record = asRecord(value);
  const summary = decodeApiRunSummary(value);
  if (
    !record ||
    !summary ||
    !isNullableString(record.org_id) ||
    !isNullableString(record.user_id) ||
    !isNullableString(record.parent_run_id) ||
    typeof record.child_session !== "boolean" ||
    typeof record.thread_id !== "string" ||
    !isNullableString(record.engine_session_id) ||
    !Array.isArray(record.resolved_resources) ||
    !record.resolved_resources.every(isRunResource) ||
    typeof record.memory_scope !== "string" ||
    !MEMORY_SCOPE_SET.has(record.memory_scope) ||
    !isNullableString(record.skill_id) ||
    !(record.skill_version === null || typeof record.skill_version === "number") ||
    !isNullableString(record.skill_content_hash) ||
    !Array.isArray(record.uploads) ||
    !Array.isArray(record.steps)
  ) {
    return null;
  }
  const uploads = record.uploads.map(decodeRunUpload);
  const steps = record.steps.map(decodeApiStep);
  if (uploads.some((item) => item === null) || steps.some((item) => item === null)) return null;
  return {
    ...summary,
    org_id: record.org_id,
    user_id: record.user_id,
    parent_run_id: record.parent_run_id,
    child_session: record.child_session,
    thread_id: record.thread_id,
    engine_session_id: record.engine_session_id,
    resolved_resources: record.resolved_resources,
    memory_scope: record.memory_scope as MemoryScope,
    skill_id: record.skill_id,
    skill_version: record.skill_version,
    skill_content_hash: record.skill_content_hash,
    uploads: uploads as RunUpload[],
    steps: steps as ApiStep[],
  };
}

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
