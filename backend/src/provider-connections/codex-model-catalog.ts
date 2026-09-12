import { listManagedCodexModels } from "./codex-app-server";
import { getCodexSubscriptionRuntimeSelection } from "./service";
import type { ProviderConnectionScope } from "./repo";

const PAGE_LIMIT = 100;
const MAX_PAGES = 4;
const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;
const LAST_KNOWN_GOOD_TTL_MS = 60 * 60_000;
const MAX_ACTOR_CACHES = 256;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

export interface NativeCodexModel {
  readonly id: string;
  readonly displayName: string;
  readonly defaultReasoningEffort?: string;
  readonly supportedReasoningEfforts: readonly string[];
}

export interface NativeCodexModelCatalog {
  readonly models: readonly NativeCodexModel[];
  readonly status: "native" | "unavailable";
  readonly stale: boolean;
  readonly error?: "not_connected" | "native_catalog_refreshing" | "native_catalog_unavailable";
}

interface CacheEntry {
  readonly authEpoch: string;
  readonly freshUntil: number;
  readonly retainUntil: number;
  readonly models: readonly NativeCodexModel[];
  readonly status: "native" | "unavailable";
  readonly error?: "native_catalog_unavailable";
}

interface Dependencies {
  readonly runtimeSelection: typeof getCodexSubscriptionRuntimeSelection;
  readonly listModels: typeof listManagedCodexModels;
  readonly now: () => number;
}

const defaultDependencies: Dependencies = {
  runtimeSelection: getCodexSubscriptionRuntimeSelection,
  listModels: listManagedCodexModels,
  now: Date.now,
};
const cache = new Map<string, CacheEntry>();
const operations = new Map<string, Promise<NativeCodexModelCatalog>>();
const activeEpochs = new Map<string, string>();

function actorKey(scope: ProviderConnectionScope): string {
  return JSON.stringify([scope.orgId, scope.userId]);
}

function pruneCache(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.retainUntil <= now) {
      cache.delete(key);
      activeEpochs.delete(key);
    }
  }
  while (cache.size >= MAX_ACTOR_CACHES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    activeEpochs.delete(oldest);
  }
}

function setCache(key: string, entry: CacheEntry, now: number): void {
  cache.delete(key);
  pruneCache(now);
  cache.set(key, entry);
}

function cachedCatalog(entry: CacheEntry, stale: boolean): NativeCodexModelCatalog {
  return {
    models: entry.models,
    status: entry.status,
    stale,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function parsePage(value: unknown): {
  models: NativeCodexModel[];
  nextCursor: string | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid native model catalog");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.data) || record.data.length > PAGE_LIMIT) {
    throw new Error("invalid native model catalog page");
  }
  const nextCursor = record.nextCursor;
  if (nextCursor !== null && nextCursor !== undefined &&
    (typeof nextCursor !== "string" || nextCursor.length === 0 || nextCursor.length > 512)) {
    throw new Error("invalid native model catalog cursor");
  }
  const models: NativeCodexModel[] = [];
  for (const value of record.data) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const model = value as Record<string, unknown>;
    if (
      typeof model.id !== "string" ||
      !MODEL_ID.test(model.id) ||
      model.hidden === true ||
      (model.model !== undefined && model.model !== model.id)
    ) continue;
    const displayName = typeof model.displayName === "string" && model.displayName.trim()
      ? model.displayName.trim().slice(0, 120)
      : model.id;
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const effort = (entry as Record<string, unknown>).reasoningEffort;
          return typeof effort === "string" && REASONING_EFFORTS.has(effort) ? [effort] : [];
        })
      : [];
    const defaultEffort = typeof model.defaultReasoningEffort === "string" &&
        REASONING_EFFORTS.has(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : undefined;
    models.push({
      id: model.id,
      displayName,
      supportedReasoningEfforts: [...new Set(efforts)],
      ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
    });
  }
  return { models, nextCursor: typeof nextCursor === "string" ? nextCursor : null };
}

async function fetchNativeCatalog(
  scope: ProviderConnectionScope,
  listModels: Dependencies["listModels"],
): Promise<readonly NativeCodexModel[]> {
  const models = new Map<string, NativeCodexModel>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const parsed = parsePage(await listModels(scope, {
      ...(cursor ? { cursor } : {}),
      limit: PAGE_LIMIT,
      includeHidden: false,
    }));
    for (const model of parsed.models) models.set(model.id, model);
    if (!parsed.nextCursor) return [...models.values()];
    if (seenCursors.has(parsed.nextCursor)) throw new Error("native model catalog cursor repeated");
    seenCursors.add(parsed.nextCursor);
    cursor = parsed.nextCursor;
  }
  throw new Error("native model catalog exceeded page bound");
}

export async function nativeCodexModelCatalog(
  scope: ProviderConnectionScope,
  options: { readonly force?: boolean; readonly dependencies?: Dependencies } = {},
): Promise<NativeCodexModelCatalog> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const now = dependencies.now();
  pruneCache(now);
  const key = actorKey(scope);
  const runtime = await dependencies.runtimeSelection(scope);
  if (!runtime) {
    cache.delete(key);
    activeEpochs.delete(key);
    return { models: [], status: "unavailable", stale: false, error: "not_connected" };
  }
  activeEpochs.set(key, runtime.authEpoch);
  let current = cache.get(key);
  if (current && current.authEpoch !== runtime.authEpoch) {
    cache.delete(key);
    current = undefined;
  }
  if (!options.force && current && current.freshUntil > now) {
    return cachedCatalog(current, current.error !== undefined);
  }
  const operationKey = `${key}\0${runtime.authEpoch}`;
  const existing = operations.get(operationKey);
  if (existing) {
    if (options.force) return existing;
    return current
      ? { ...cachedCatalog(current, true), error: "native_catalog_refreshing" }
      : {
          models: [],
          status: "unavailable",
          stale: true,
          error: "native_catalog_refreshing",
        };
  }
  const operation = (async (): Promise<NativeCodexModelCatalog> => {
    try {
      const models = await fetchNativeCatalog(scope, dependencies.listModels);
      const completedAt = dependencies.now();
      if (activeEpochs.get(key) === runtime.authEpoch) {
        setCache(key, {
          authEpoch: runtime.authEpoch,
          freshUntil: completedAt + CACHE_TTL_MS,
          retainUntil: completedAt + LAST_KNOWN_GOOD_TTL_MS,
          models,
          status: "native",
        }, completedAt);
      }
      return { models, status: "native", stale: false };
    } catch {
      const completedAt = dependencies.now();
      if (current?.authEpoch === runtime.authEpoch) {
        if (activeEpochs.get(key) === runtime.authEpoch) {
          setCache(key, {
            ...current,
            freshUntil: completedAt + FAILURE_TTL_MS,
            error: "native_catalog_unavailable",
          }, completedAt);
        }
        return {
          models: current.models,
          status: current.status,
          stale: true,
          error: "native_catalog_unavailable",
        };
      }
      if (activeEpochs.get(key) === runtime.authEpoch) {
        setCache(key, {
          authEpoch: runtime.authEpoch,
          freshUntil: completedAt + FAILURE_TTL_MS,
          retainUntil: completedAt + FAILURE_TTL_MS,
          models: [],
          status: "unavailable",
          error: "native_catalog_unavailable",
        }, completedAt);
      }
      return {
        models: [],
        status: "unavailable",
        stale: true,
        error: "native_catalog_unavailable",
      };
    }
  })().finally(() => {
    operations.delete(operationKey);
  });
  operations.set(operationKey, operation);
  if (options.force) return operation;
  void operation;
  return current
    ? { ...cachedCatalog(current, true), error: "native_catalog_refreshing" }
    : {
        models: [],
        status: "unavailable",
        stale: true,
        error: "native_catalog_refreshing",
      };
}

export function resetNativeCodexModelCatalogForTest(): void {
  cache.clear();
  operations.clear();
  activeEpochs.clear();
}
