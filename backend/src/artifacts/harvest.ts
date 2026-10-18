import { SANDBOX_STATE_DIR } from "../sandboxes/sandbox-names";
import { PLATFORM_EVENT_LANES } from "@useagent/agent-harness/canonical";
import { posix } from "node:path";
import { getRun } from "../runs/repo";
import { readStableProviderEvent, recordProviderEventIfAbsent } from "../runs/provider-events";
import { resolveRunSandbox } from "../sandboxes/binding";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  requiresScreenshotProofPurpose,
  resolveAttachedSandboxWorkspaceRoot,
} from "../sandboxes/workspace";
import { awaitWithSignal } from "../util/abortable-operation";
import { MAX_ARTIFACT_BYTES } from "./publish";

const DELIVERABLE_EXTENSIONS = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "md", "html",
  "txt", "json", "xml", "png", "jpg", "jpeg", "gif", "webp", "svg", "mp4",
  "webm", "mp3", "wav", "zip", "tar", "gz",
] as const;
const PRUNED_DIRECTORIES = [
  "node_modules", ".git", ".cache", ".venv", "venv", "__pycache__", "dist", "build", ".next",
  ".claude", ".codex", ".opencode", ".pi", ".config", "coverage",
  // The plane's state directory, and the inputs directory older releases used in retained sandboxes.
  ".useagent", SANDBOX_STATE_DIR, `${SANDBOX_STATE_DIR}-inputs`, ".useagent-inputs", "target",
] as const;
export const MAX_HARVESTED_FILES = 20;
export const MAX_LISTING_RECORDS = 3000;
const LISTING_TIMEOUT_SECONDS = 30;
/** Waits before each repeated listing. A sandbox request can drop mid-flight
 *  (prod 2026-10-12: an E2B SandboxError failed a finished run, and the
 *  user's resend worked), and listing is read-only, so it is safe to repeat. */
const LISTING_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];
/** Only a listing that failed fast is repeated: one that ran into its own
 *  timeout would push discovery past the output budget. */
const LISTING_RETRY_WINDOW_MS = 10_000;
const LISTING_COMPLETE = "__USEAGENT_LISTING_COMPLETE__";
const BASELINE_EVENT_TYPE = "artifact.output-baseline";
const BASELINE_PROVIDER = PLATFORM_EVENT_LANES.platform;
const TIMESTAMP_PATTERN = /^\d+\.\d+$/;

export interface HarvestCandidate {
  readonly path: string;
  readonly size: number;
}

/** What automatic discovery offers, and what it knowingly left out: changed
 *  files that are empty or over the artifact size limit, and `truncated` when
 *  more changed deliverables existed than one turn delivers. */
export interface TurnOutputDiscovery {
  readonly candidates: HarvestCandidate[];
  readonly withheldPaths: string[];
  readonly truncated: boolean;
}

/** A turn changed more deliverable-looking files than one delivery holds. A
 *  product limit on automatic discovery, not a failed delivery. */
export class TooManyTurnOutputs extends Error {}

/** The sandbox would not answer a read-only listing even after retries: the
 *  request never came back, as opposed to a listing that came back wrong,
 *  which still fails delivery. */
export class TurnOutputListingUnavailable extends Error {}

/** The listing command ran and exited non-zero: the sandbox answered, so it is
 *  neither repeated nor treated as a dropped request. */
export class TurnOutputListingFailed extends Error {}

export type RunRow = NonNullable<Awaited<ReturnType<typeof getRun>>>;

export interface DiscoveryDependencies {
  readonly list: (run: RunRow, command: string) => Promise<string>;
  readonly retryDelaysMs?: readonly number[];
}

/** A request that never came back: E2B's dropped or timed-out RPC, or a
 *  network error. The only listing failure worth repeating; any other error
 *  (a truncated or refused result, say) is an answer and fails delivery. */
function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "SandboxError" || error.name === "TimeoutError") return true;
  const code = (error as { code?: unknown }).code;
  return (typeof code === "string" && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_)/.test(code)) ||
    /fetch failed|socket hang up/i.test(error.message);
}

/** Whether the run's bound sandbox still runs a trivial command. A listing
 *  that failed against a sandbox that still answers is a dropped request; a
 *  sandbox that does not answer is gone, and delivery fails as before. */
export async function sandboxStillAnswers(run: RunRow, signal?: AbortSignal): Promise<boolean> {
  try {
    const sandbox = await awaitWithSignal(() => resolveRunSandbox(run), signal);
    const result = await awaitWithSignal(() => sandbox.process.executeCommand("true", undefined, undefined, 10), signal);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const pruneClause = (names: readonly string[]) => names
  .map((name) => `-name ${shellQuote(name)}`)
  .join(" -o ");

function boundedListing(find: string): string {
  return [
    "set -eu",
    "listing_file=$(mktemp)",
    "trap 'rm -f \"$listing_file\"' EXIT HUP INT TERM",
    `${find} >"$listing_file" 2>/dev/null`,
    `head -z -n ${MAX_LISTING_RECORDS + 1} "$listing_file"`,
    `printf ${shellQuote(`${LISTING_COMPLETE}\\0`)}`,
  ].join("\n");
}

/** Find every repository marker while pruning dependency trees at depth one.
 * The parser drops the workspace root's own marker. */
export function repositoryListCommand(workspaceRoot: string): string {
  const root = shellQuote(workspaceRoot);
  return boundedListing(
    `find ${root} -xdev \\( ${pruneClause(PRUNED_DIRECTORIES.filter((name) => name !== ".git"))} -o -path ${shellQuote(`${workspaceRoot}/screenshots`)} \\) -prune ` +
    `-o -name .git -printf '%h\\0' -prune`,
  );
}

/** Find recognized deliverables whose inode changed after the sandbox-clock
 * baseline. The change time is used rather than the modification time: a copy
 * or extraction that preserves the modification time (`cp -p`, `tar`,
 * `rsync -a`) still changes the inode, and nothing in user space can set the
 * change time, so a deliverable placed with an old mtime is still found.
 * `topLevelOnly` lists the workspace root's own files, nothing below it. */
export function fileListCommand(
  workspaceRoot: string,
  since: string,
  repositoryRoots: readonly string[],
  options: { readonly topLevelOnly?: boolean } = {},
): string {
  if (!TIMESTAMP_PATTERN.test(since)) throw new Error("artifact output baseline timestamp is invalid");
  const root = shellQuote(workspaceRoot);
  const names = DELIVERABLE_EXTENSIONS.map((ext) => `-iname ${shellQuote(`*.${ext}`)}`).join(" -o ");
  const matches = `-type f -newerct ${shellQuote(`@${since}`)} \\( ${names} \\) -printf '%s\\t%p\\0'`;
  if (options.topLevelOnly) return boundedListing(`find ${root} -maxdepth 1 ${matches}`);
  const repositories = repositoryRoots.map((path) => `-path ${shellQuote(path)}`);
  const prune = [pruneClause(PRUNED_DIRECTORIES), `-path ${shellQuote(`${workspaceRoot}/screenshots`)}`, ...repositories].join(" -o ");
  return boundedListing(`find ${root} -xdev \\( ${prune} \\) -prune -o ${matches}`);
}

function listingRecords(output: string): string[] {
  const suffix = `${LISTING_COMPLETE}\0`;
  if (!output.endsWith(suffix)) throw new Error("artifact listing was incomplete");
  const body = output.slice(0, -suffix.length);
  const records = body ? body.split("\0") : [];
  if (records.at(-1) === "") records.pop();
  if (records.length > MAX_LISTING_RECORDS) throw new TooManyTurnOutputs("artifact listing exceeded 3000 records");
  return records;
}

export function parseRepositoryListing(output: string, workspaceRoot: string): string[] {
  const roots = listingRecords(output).filter((path) => path !== workspaceRoot);
  for (const path of roots) {
    if (!path.startsWith(`${workspaceRoot}/`)) throw new Error("repository listing escaped the workspace");
  }
  return [...new Set(roots)].toSorted();
}

export function parseFileListing(
  output: string,
  workspaceRoot: string,
  repositoryRoots: readonly string[],
): Omit<TurnOutputDiscovery, "truncated"> {
  const candidates: HarvestCandidate[] = [];
  const withheldPaths: string[] = [];
  for (const record of listingRecords(output)) {
    const tab = record.indexOf("\t");
    if (tab <= 0) throw new Error("artifact listing record is malformed");
    const sizeText = record.slice(0, tab);
    const size = Number(sizeText);
    const path = record.slice(tab + 1);
    if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size)) throw new Error("artifact listing size is invalid");
    if (!path.startsWith(`${workspaceRoot}/`)) throw new Error("artifact listing escaped the workspace");
    if (repositoryRoots.some((root) => path === root || path.startsWith(`${root}/`))) continue;
    if (path.startsWith(`${workspaceRoot}/screenshots/`) || requiresScreenshotProofPurpose(path)) continue;
    if (size === 0 || size > MAX_ARTIFACT_BYTES) {
      withheldPaths.push(path);
      continue;
    }
    candidates.push({ path, size });
  }
  if (candidates.length > MAX_HARVESTED_FILES) {
    throw new TooManyTurnOutputs(`automatic artifact discovery exceeded ${MAX_HARVESTED_FILES} candidates`);
  }
  return { candidates: candidates.toSorted((a, b) => a.path.localeCompare(b.path)), withheldPaths };
}

async function sandboxList(run: RunRow, command: string): Promise<string> {
  const sandbox = await resolveRunSandbox(run);
  const result = await sandbox.process.executeCommand(command, undefined, undefined, LISTING_TIMEOUT_SECONDS);
  if (result.exitCode !== 0) throw new TurnOutputListingFailed("artifact listing command failed");
  return result.result ?? "";
}

const defaultDependencies: DiscoveryDependencies = { list: sandboxList };

interface OutputBaseline {
  readonly timestamp: string;
  readonly sandboxId: string;
  readonly workdir: string;
}

function parseBaseline(payload: string | null): OutputBaseline {
  let value: unknown;
  try {
    value = payload === null ? null : JSON.parse(payload);
  } catch {
    throw new Error("artifact output baseline payload is invalid");
  }
  if (
    typeof value !== "object" || value === null ||
    !("timestamp" in value) || typeof value.timestamp !== "string" || !TIMESTAMP_PATTERN.test(value.timestamp) ||
    !("sandboxId" in value) || typeof value.sandboxId !== "string" || !value.sandboxId ||
    !("workdir" in value) || typeof value.workdir !== "string" ||
    !posix.isAbsolute(value.workdir) || posix.normalize(value.workdir) !== value.workdir
  ) {
    throw new Error("artifact output baseline payload is invalid");
  }
  return { timestamp: value.timestamp, sandboxId: value.sandboxId, workdir: value.workdir };
}

/** Capture the sandbox's own clock immediately before a user turn. The stable
 * provider-event id makes retries preserve the original first-attempt boundary. */
export async function recordOutputBaseline(
  runId: string,
  sandbox: SandboxHandle,
  workdir: string,
  signal?: AbortSignal,
): Promise<void> {
  const run = await awaitWithSignal(() => getRun(runId), signal);
  if (!run) throw new Error(`run ${runId} not found`);
  if (!run.sandboxId || run.sandboxId !== sandbox.id) throw new Error("artifact output baseline sandbox mismatch");
  if (!posix.isAbsolute(workdir) || posix.normalize(workdir) !== workdir) {
    throw new Error("artifact output baseline workdir is invalid");
  }
  const result = await awaitWithSignal(
    () => sandbox.process.executeCommand("date +%s.%N", workdir, undefined, LISTING_TIMEOUT_SECONDS),
    signal,
  );
  const timestamp = result.result?.trim() ?? "";
  if (result.exitCode !== 0 || !TIMESTAMP_PATTERN.test(timestamp)) {
    throw new Error("failed to capture artifact output baseline");
  }
  await awaitWithSignal(() => recordProviderEventIfAbsent({
    id: `${runId}:artifact-output-baseline`,
    runId,
    threadId: run.threadId,
    provider: BASELINE_PROVIDER,
    eventType: BASELINE_EVENT_TYPE,
    payload: { timestamp, sandboxId: sandbox.id, workdir },
  }), signal);
}

/** Discover automatic deliverables only. Publication, digesting, revisions,
 * and explicit output links are handled by the shared completion consumer. */
export async function discoverTurnOutputs(
  run: RunRow,
  options: { readonly signal?: AbortSignal } = {},
  dependencies: DiscoveryDependencies = defaultDependencies,
): Promise<TurnOutputDiscovery> {
  const event = await awaitWithSignal(() => readStableProviderEvent({
    id: `${run.id}:artifact-output-baseline`,
    runId: run.id,
    threadId: run.threadId,
  }), options.signal);
  if (!event) return { candidates: [], withheldPaths: [], truncated: false };
  if (event.provider !== BASELINE_PROVIDER || event.eventType !== BASELINE_EVENT_TYPE) {
    throw new Error("artifact output baseline event is invalid");
  }
  const baseline = parseBaseline(event.payload);
  if (!run.sandboxId || baseline.sandboxId !== run.sandboxId) {
    throw new Error("artifact output baseline sandbox mismatch");
  }
  const workspaceRoot = await awaitWithSignal(() => resolveAttachedSandboxWorkspaceRoot({
    sandboxId: run.sandboxId!,
    sandboxProvider: run.sandboxProvider,
  }), options.signal);
  if (baseline.workdir !== workspaceRoot) throw new Error("artifact output baseline workdir mismatch");

  const delays = dependencies.retryDelaysMs ?? LISTING_RETRY_DELAYS_MS;
  const list = async (command: string): Promise<string> => {
    const started = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await awaitWithSignal(() => dependencies.list(run, command), options.signal);
      } catch (error) {
        if (options.signal?.aborted || error instanceof TurnOutputListingFailed) throw error;
        if (!isTransportFailure(error)) throw new TurnOutputListingFailed("artifact listing was refused", { cause: error });
        const delay = delays[attempt];
        if (delay === undefined || Date.now() - started > LISTING_RETRY_WINDOW_MS) {
          throw new TurnOutputListingUnavailable("sandbox listing unavailable", { cause: error });
        }
        await awaitWithSignal(() => Bun.sleep(delay), options.signal);
      }
    }
  };
  const overflow = (error: unknown) => {
    if (!(error instanceof TooManyTurnOutputs)) throw error;
  };
  // More repository markers than a listing holds says nothing about changed
  // outputs, so only the file listing's overflow counts as files left out.
  let repositories: string[] | null = null;
  try {
    repositories = parseRepositoryListing(await list(repositoryListCommand(workspaceRoot)), workspaceRoot);
  } catch (error) {
    overflow(error);
  }
  if (repositories) {
    try {
      const found = parseFileListing(await list(fileListCommand(workspaceRoot, baseline.timestamp, repositories)), workspaceRoot, repositories);
      return { ...found, truncated: false };
    } catch (error) {
      overflow(error);
    }
  }
  // A project tree changed more files than one turn delivers (or could not be
  // told apart from its repositories): offer only the workspace's own
  // top-level files, where a finished zip or report lands, and none when even
  // those are past the cap.
  try {
    const topLevel = parseFileListing(
      await list(fileListCommand(workspaceRoot, baseline.timestamp, [], { topLevelOnly: true })),
      workspaceRoot,
      [],
    );
    return { ...topLevel, truncated: repositories !== null };
  } catch (error) {
    overflow(error);
    return { candidates: [], withheldPaths: [], truncated: true };
  }
}
