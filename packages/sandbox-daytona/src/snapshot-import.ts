// A Daytona snapshot from an image that already exists in a registry. Daytona
// pulls the image itself, so a private registry is registered in the org first
// (once). The snapshot is org-scoped: every key of the org can start from it.
import { Daytona, DaytonaNotFoundError } from "@daytona/sdk";
import type { SandboxTemplateStatus } from "@useagent/sandbox-contract";
import type { DaytonaApiConfig } from "./provider";

const IMPORT_DEADLINE_MS = 30 * 60_000;
const DELETE_DEADLINE_MS = 60_000;
const POLL_MS = 5_000;
const DELETE_POLL_MS = 2_000;
const REGISTRY_REQUEST_TIMEOUT_MS = 15_000;
const TERMINAL_FAILURES: ReadonlySet<string> = new Set(["error", "build_failed"]);
const ACTIVATING_STATES: ReadonlySet<string> = new Set([
  "building",
  "pending",
  "pulling",
  "snapshotting",
  "inactive",
]);
const DEFAULT_RESOURCES = { cpu: 2, memory: 8, disk: 10 } as const;

export interface DaytonaRegistryCredential {
  /** Registry host, no scheme (registry.example.com). */
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly name?: string;
}

export interface ImportDaytonaSnapshotInput {
  readonly name: string;
  /** `host/repo:tag`; a digest suffix is refused by Daytona's runner. */
  readonly image: string;
  readonly registry?: DaytonaRegistryCredential;
  /** Replace a snapshot of the same name even when it is active. */
  readonly force?: boolean;
  readonly resources?: { readonly cpu: number; readonly memory: number; readonly disk: number };
  readonly log?: (line: string) => void;
}

type DaytonaSdkSnapshot = Awaited<ReturnType<Daytona["snapshot"]["get"]>>;
type SnapshotResources = NonNullable<ImportDaytonaSnapshotInput["resources"]>;

interface SnapshotImportRecord {
  readonly name: string;
  readonly imageName?: string;
  readonly state: string;
  readonly cpu: number;
  readonly mem: number;
  readonly disk: number;
  readonly errorReason?: string | null;
}

export interface DaytonaSnapshotImportClient {
  readonly snapshot: {
    get(name: string): Promise<SnapshotImportRecord>;
    delete(snapshot: SnapshotImportRecord): Promise<void>;
    activate(snapshot: SnapshotImportRecord): Promise<SnapshotImportRecord>;
    create(
      params: {
        readonly name: string;
        readonly image: string;
        readonly resources: { readonly cpu: number; readonly memory: number; readonly disk: number };
        readonly entrypoint: readonly string[];
      },
      options: { readonly onLogs: (line: string) => void; readonly timeout: number },
    ): Promise<SnapshotImportRecord>;
  };
  readonly [Symbol.asyncDispose]?: () => Promise<void>;
}

export interface ImportDaytonaSnapshotDependencies {
  readonly createClient?: (config: DaytonaApiConfig) => DaytonaSnapshotImportClient;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

function createSnapshotImportClient(config: DaytonaApiConfig): DaytonaSnapshotImportClient {
  const client = new Daytona({
    ...config,
    // Snapshot import observes snapshot metadata only. Avoid opening the SDK's
    // sandbox-state WebSocket dispatcher for this bounded operator action.
    useDeprecatedPolling: true,
  });
  return {
    snapshot: {
      get: async (name) => await client.snapshot.get(name),
      delete: async (snapshot) => await client.snapshot.delete(snapshot as DaytonaSdkSnapshot),
      activate: async (snapshot) => await client.snapshot.activate(snapshot as DaytonaSdkSnapshot),
      create: async (params, options) => await client.snapshot.create({
        ...params,
        entrypoint: [...params.entrypoint],
      }, options),
    },
    [Symbol.asyncDispose]: async () => await client[Symbol.asyncDispose](),
  };
}

/** Register the registry in the org unless a registry with that host already is. */
export async function ensureDaytonaRegistry(
  config: Pick<DaytonaApiConfig, "apiKey" | "apiUrl" | "requestTimeoutMs">,
  registry: DaytonaRegistryCredential,
): Promise<"registered" | "present"> {
  const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
  const requestTimeoutMs = Math.min(
    REGISTRY_REQUEST_TIMEOUT_MS,
    Math.max(1, config.requestTimeoutMs ?? REGISTRY_REQUEST_TIMEOUT_MS),
  );
  const listing = await fetch(`${config.apiUrl}/docker-registry`, {
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!listing.ok) throw new Error(`Daytona registry listing failed (${listing.status})`);
  const registries = (await listing.json()) as { url?: string }[];
  const host = registry.url.replace(/^https?:\/\//, "");
  if (registries.some((entry) => (entry.url ?? "").replace(/^https?:\/\//, "") === host)) return "present";
  const response = await fetch(`${config.apiUrl}/docker-registry`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs),
    body: JSON.stringify({
      name: registry.name ?? "useagent-sandbox-registry",
      url: host,
      username: registry.username,
      password: registry.password,
    }),
  });
  if (!response.ok) throw new Error(`Daytona registry registration failed (${response.status})`);
  return "registered";
}

function hasRequestedResources(
  snapshot: SnapshotImportRecord,
  resources: SnapshotResources,
): boolean {
  return snapshot.cpu >= resources.cpu &&
    snapshot.mem >= resources.memory &&
    snapshot.disk >= resources.disk;
}

function activeStatus(
  snapshot: SnapshotImportRecord,
  resources: SnapshotResources,
  expectedName: string,
  expectedImage: string,
): SandboxTemplateStatus {
  if (snapshot.name !== expectedName || snapshot.imageName !== expectedImage) {
    return {
      name: expectedName,
      state: "error",
      detail: "active snapshot provenance does not match the requested name and image",
    };
  }
  if (hasRequestedResources(snapshot, resources)) {
    return { name: expectedName, state: "active" };
  }
  return {
    name: snapshot.name,
    state: "error",
    detail:
      `active snapshot resources ${snapshot.cpu} CPU/${snapshot.mem} GiB memory/${snapshot.disk} GiB disk ` +
      `are below requested ${resources.cpu} CPU/${resources.memory} GiB memory/${resources.disk} GiB disk`,
  };
}

function nonActiveStatus(snapshot: SnapshotImportRecord): SandboxTemplateStatus {
  if (snapshot.state === "inactive") {
    return { name: snapshot.name, state: "inactive", detail: snapshot.state };
  }
  if (ACTIVATING_STATES.has(snapshot.state)) {
    return { name: snapshot.name, state: "activating", detail: snapshot.state };
  }
  return {
    name: snapshot.name,
    state: "error",
    detail: snapshot.errorReason?.trim() || snapshot.state,
  };
}

async function importWithClient(
  client: DaytonaSnapshotImportClient,
  input: ImportDaytonaSnapshotInput,
  dependencies: Required<Pick<ImportDaytonaSnapshotDependencies, "sleep" | "now">>,
): Promise<SandboxTemplateStatus> {
  const log = input.log ?? (() => {});
  const resources = input.resources ?? DEFAULT_RESOURCES;
  let existing: SnapshotImportRecord | null;
  try {
    existing = await client.snapshot.get(input.name);
  } catch (error) {
    if (!(error instanceof DaytonaNotFoundError)) throw error;
    existing = null;
  }

  if (existing && existing.name !== input.name) {
    throw new Error(`Daytona returned snapshot ${existing.name} for requested name ${input.name}`);
  }

  if (existing && !input.force) {
    if (existing.imageName !== input.image) {
      return {
        name: input.name,
        state: "error",
        detail: "existing snapshot provenance does not match the requested image",
      };
    }
    if (existing.state === "active") {
      return activeStatus(existing, resources, input.name, input.image);
    }
    if (!ACTIVATING_STATES.has(existing.state)) return nonActiveStatus(existing);
    if (existing.state === "inactive") {
      existing = await client.snapshot.activate(existing);
      if (existing.name !== input.name) {
        throw new Error(`Daytona activated snapshot ${existing.name} for requested name ${input.name}`);
      }
      if (existing.state === "active") {
        return activeStatus(existing, resources, input.name, input.image);
      }
      if (!ACTIVATING_STATES.has(existing.state)) return nonActiveStatus(existing);
    }
    const startedAt = dependencies.now();
    while (dependencies.now() - startedAt < IMPORT_DEADLINE_MS) {
      await dependencies.sleep(POLL_MS);
      existing = await client.snapshot.get(input.name);
      if (existing.name !== input.name) {
        throw new Error(`Daytona returned snapshot ${existing.name} for requested name ${input.name}`);
      }
      if (existing.state === "active") {
        return activeStatus(existing, resources, input.name, input.image);
      }
      if (!ACTIVATING_STATES.has(existing.state)) return nonActiveStatus(existing);
    }
    return nonActiveStatus(existing);
  }

  if (existing) {
    log(`removing the previous ${input.name} (${existing.state})`);
    await client.snapshot.delete(existing);
    const deleteStartedAt = dependencies.now();
    while (dependencies.now() - deleteStartedAt < DELETE_DEADLINE_MS) {
      try {
        const current = await client.snapshot.get(input.name);
        if (current.name !== input.name) {
          throw new Error(`Daytona returned snapshot ${current.name} for requested name ${input.name}`);
        }
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) {
          existing = null;
          break;
        }
        throw error;
      }
      await dependencies.sleep(DELETE_POLL_MS);
    }
    if (existing) {
      throw new Error(`Daytona snapshot ${input.name} was not deleted within 60 seconds`);
    }
  }

  const startedAt = dependencies.now();
  log(`creating ${input.name} from ${input.image}`);
  let snapshot = await client.snapshot.create(
    {
      name: input.name,
      image: input.image,
      resources,
      entrypoint: ["sleep", "infinity"],
    },
    { onLogs: (line) => log(line), timeout: IMPORT_DEADLINE_MS / 1000 },
  );
  while (
    snapshot.state !== "active" &&
    !TERMINAL_FAILURES.has(snapshot.state) &&
    dependencies.now() - startedAt < IMPORT_DEADLINE_MS
  ) {
    await dependencies.sleep(POLL_MS);
    snapshot = await client.snapshot.get(input.name);
  }
  if (snapshot.state === "active") {
    return activeStatus(snapshot, resources, input.name, input.image);
  }
  return {
    name: input.name,
    state: "error",
    detail: snapshot.errorReason?.trim() ||
      `${snapshot.state} after ${Math.round((dependencies.now() - startedAt) / 1000)}s`,
  };
}

export async function importDaytonaSnapshot(
  config: DaytonaApiConfig,
  input: ImportDaytonaSnapshotInput,
  dependencies: ImportDaytonaSnapshotDependencies = {},
): Promise<SandboxTemplateStatus> {
  if (input.image.includes("@sha256:")) {
    throw new Error("Daytona snapshots are created from a tag reference; drop the digest suffix");
  }
  if (input.registry) {
    const log = input.log ?? (() => {});
    log(`registry ${input.registry.url}: ${await ensureDaytonaRegistry(config, input.registry)}`);
  }

  const client = (dependencies.createClient ?? createSnapshotImportClient)(config);
  let result: SandboxTemplateStatus | undefined;
  let operationError: unknown;
  try {
    result = await importWithClient(client, input, {
      sleep: dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: dependencies.now ?? Date.now,
    });
  } catch (error) {
    operationError = error;
  }
  try {
    await client[Symbol.asyncDispose]?.();
  } catch (error) {
    operationError ??= error;
  }
  if (operationError) throw operationError;
  return result!;
}
