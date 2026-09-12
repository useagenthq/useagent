"use client";

import { RiArrowDownSLine, RiCheckLine, RiCpuLine, RiRefreshLine } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import {
  ENGINES,
  type EngineId,
  isFreeModel,
  modelLabel,
  modelOptionsForEngine,
  partitionModelOptions,
  selectableModelsForEngine,
} from "@/components/chat/types";
import { useCapabilityCatalog } from "@/hooks/use-capability-catalog";
import type { CapabilityCatalog, CapabilityEngineRuntime } from "@/lib/capability-catalog";
import { cx as cn } from "@/utils/cx";

export type EngineModelCatalog = Partial<Record<EngineId, readonly string[]>>;
export interface EngineReadinessStatus {
  readonly ready: boolean;
  readonly reason: "enabled" | "disabled" | "provider_unhealthy" | "not_proven";
  readonly provider?: "anthropic" | "openai" | "openrouter";
  readonly providerHealth?: string;
  readonly message?: string;
}
export type EngineReadinessCatalog = Partial<Record<EngineId, EngineReadinessStatus>>;

const ENGINE_RUNTIME_CAPTIONS: Partial<Record<EngineId, string>> = {
  opencode: "any model · cloud sandbox",
  claude: "Anthropic agent · cloud sandbox",
  codex: "OpenAI agent · cloud sandbox",
  pi: "native Pi harness · cloud sandbox",
  chat: "direct model · no sandbox",
};

export function engineRuntimeCaption(
  engine: EngineId,
  runtime: CapabilityEngineRuntime | undefined,
  readiness: EngineReadinessStatus | undefined,
): string {
  const label = runtime ? ENGINE_RUNTIME_CAPTIONS[engine] ?? "Runtime unavailable" : "Runtime unavailable";
  return `${label}${readiness?.ready === false ? " · needs attention" : ""}`;
}

export function engineConfigFromCapabilityCatalog(catalog: CapabilityCatalog): {
  engines: EngineId[];
  models: EngineModelCatalog;
  readiness: EngineReadinessCatalog;
  runtimes: Partial<Record<EngineId, CapabilityEngineRuntime>>;
} {
  const configured = catalog.engines.filter((engine) => engine.configured);
  return {
    engines: configured.map((engine) => engine.id),
    models: Object.fromEntries(
      configured.map((engine) => [
        engine.id,
        engine.models
          .filter((model) => model.dispatchable)
          .sort((left, right) => Number(right.default) - Number(left.default))
          .map((model) => model.id),
      ]),
    ),
    readiness: Object.fromEntries(
      configured.map((engine) => [
        engine.id,
        {
          ready: engine.ready,
          reason: engine.degradationReason ?? "enabled",
          ...(engine.message ? { message: engine.message } : {}),
        },
      ]),
    ),
    runtimes: Object.fromEntries(configured.map((engine) => [engine.id, engine.runtime])),
  };
}

export function resolveEnabledEngine(
  current: EngineId,
  enabled: readonly EngineId[],
): EngineId | null {
  if (enabled.includes(current)) return current;
  return enabled[0] ?? null;
}

export function fallbackEnabledEngineConfig() {
  return {
    engines: ["opencode"] as EngineId[],
    models: {
      opencode: selectableModelsForEngine("opencode").map((model) => model.value),
    } satisfies EngineModelCatalog,
    readiness: {} as EngineReadinessCatalog,
    runtimes: {} as Partial<Record<EngineId, CapabilityEngineRuntime>>,
    loaded: false,
    readinessKnown: false,
  };
}

function parseEngineModelCatalog(raw: unknown): EngineModelCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: EngineModelCatalog = {};
  for (const engine of ENGINES) {
    const models = (raw as Record<string, unknown>)[engine.id];
    if (!Array.isArray(models)) continue;
    const ids = models.filter(
      (model): model is string => typeof model === "string" && model.trim().length > 0,
    );
    if (ids.length > 0) out[engine.id] = ids;
  }
  return out;
}

export function parseEngineReadinessCatalog(raw: unknown): EngineReadinessCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: EngineReadinessCatalog = {};
  for (const engine of ENGINES) {
    const status = (raw as Record<string, unknown>)[engine.id];
    if (!status || typeof status !== "object" || Array.isArray(status)) continue;
    const value = status as Record<string, unknown>;
    if (typeof value.ready !== "boolean" || typeof value.reason !== "string") continue;
    out[engine.id] = {
      ready: value.ready,
      reason: value.reason as EngineReadinessStatus["reason"],
      ...(typeof value.provider === "string"
        ? { provider: value.provider as EngineReadinessStatus["provider"] }
        : {}),
      ...(typeof value.providerHealth === "string" ? { providerHealth: value.providerHealth } : {}),
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    };
  }
  return out;
}

/** A manual refresh may rotate the live lane, but selections already offered in
 * this browser session stay submit-able while newly discovered models append. */
export function mergeEngineModelCatalog(
  current: EngineModelCatalog,
  refreshed: EngineModelCatalog,
  preserveModel?: string,
): EngineModelCatalog {
  const merged: EngineModelCatalog = { ...refreshed };
  if (!preserveModel || !isFreeModel(preserveModel)) return merged;
  for (const engine of ENGINES) {
    const next = refreshed[engine.id];
    if (!next || !current[engine.id]?.includes(preserveModel) || next.includes(preserveModel)) {
      continue;
    }
    merged[engine.id] = [...next, preserveModel];
  }
  return merged;
}

/**
 * Ask the backend to re-derive the Free model lane from the live catalog
 * (POST busts its TTL cache) and return the refreshed per-engine manifest.
 * Null on failure or rate-limit - the caller keeps its current catalog.
 * The fetcher seam keeps this testable without a network.
 */
export async function requestModelCatalogRefresh(
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<EngineModelCatalog | null> {
  try {
    const res = await fetcher("/api/config/models/refresh", { method: "POST" });
    if (!res.ok) return null;
    const j = (await res.json()) as { models?: unknown; configuredModels?: unknown };
    return parseEngineModelCatalog(j.configuredModels ?? j.models);
  } catch {
    return null;
  }
}

export function useEnabledEngineConfig(): {
  engines: EngineId[];
  models: EngineModelCatalog;
  readiness: EngineReadinessCatalog;
  runtimes: Partial<Record<EngineId, CapabilityEngineRuntime>>;
  /** True once GET /api/capabilities resolved (or failed): before that the engines
   * list is the conservative fallback and must not demote a richer default. */
  loaded: boolean;
  /** True only when the server returned an engines manifest. */
  readinessKnown: boolean;
  /** Manual Free-lane refresh: swaps the refreshed manifest in place; a failed
   * or rate-limited request keeps the current catalog. */
  refreshModels: (preserveModel?: string) => Promise<void>;
} {
  const capabilityState = useCapabilityCatalog();
  const [config, setConfig] = useState<{
    engines: EngineId[];
    models: EngineModelCatalog;
    readiness: EngineReadinessCatalog;
    runtimes: Partial<Record<EngineId, CapabilityEngineRuntime>>;
    loaded: boolean;
    readinessKnown: boolean;
  }>(fallbackEnabledEngineConfig);
  useEffect(() => {
    const catalog = capabilityState.catalog;
    if (!catalog) {
      if (capabilityState.loaded) setConfig((current) => ({ ...current, loaded: true }));
      return;
    }
    const next = engineConfigFromCapabilityCatalog(catalog);
    setConfig({
      ...next,
      loaded: true,
      readinessKnown: true,
    });
  }, [capabilityState.catalog, capabilityState.loaded]);
  const refreshModels = useCallback(async (preserveModel?: string) => {
    const models = await requestModelCatalogRefresh();
    if (!models || Object.keys(models).length === 0) return;
    setConfig((c) => ({
      ...c,
      models: mergeEngineModelCatalog(c.models, models, preserveModel),
    }));
  }, []);
  return { ...config, refreshModels };
}

/** Configured user-facing engines from GET /api/capabilities. Dispatch readiness is
 * carried separately in `readiness`, so a provider problem stays discoverable
 * and actionable instead of making its engine disappear. */
export function useEnabledEngines(): EngineId[] {
  return useEnabledEngineConfig().engines;
}

/**
 * The `✳ <engine> ⌄` model picker from the HeyRico hero — an orange asterisk +
 * the current engine label + a dropdown of the sandbox engines. This is the
 * engine selector integrated "next to the model" per spec.
 */
export function ModelPicker({
  engine,
  model,
  onChange,
  className,
}: {
  engine: EngineId;
  model: string;
  onChange: (model: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { models: modelCatalog, refreshModels } = useEnabledEngineConfig();
  const models = modelOptionsForEngine(engine, modelCatalog[engine] ?? []);
  // The zero-cost OpenRouter ":free" variants render under their own section;
  // membership is manifest-driven (":free" id suffix), never a hardcoded list.
  const { paid, free } = partitionModelOptions(models);
  const sections = [
    { label: "Model", options: paid },
    { label: "Free", options: free },
  ].filter((section) => section.options.length > 0);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshModels(model);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        data-testid="model-picker"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Model: ${modelLabel(model, engine)}`}
        className="text-text-primary hover:bg-background-primary-hover flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-body-2-medium transition-colors"
      >
        {/* Engine chip glyph — the AsteriskMark is useAgent's brand, not an
            engine's; match the composer's neutral cpu icon instead. Below sm the
            label folds into the accessible name so the reply placeholder keeps
            one line at phone width. */}
        <RiCpuLine className="text-text-secondary size-4" aria-hidden />
        <span className="max-sm:sr-only">{modelLabel(model, engine)}</span>
        <RiArrowDownSLine className="text-text-tertiary size-4 max-sm:hidden" aria-hidden />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" aria-hidden onClick={() => setOpen(false)} />
          <div className="border-border-button-default bg-background-primary-default shadow-dropdown absolute bottom-11 right-0 z-20 w-56 rounded-2xl border p-1.5">
            {sections.map((section) => (
              <div key={section.label}>
                <div className="flex items-center justify-between">
                  <p className="text-mono-label text-text-tertiary px-2 pb-1 pt-1.5">
                    {section.label}
                  </p>
                  {/* The Free lane tracks OpenRouter's live catalog; the refresh
                      re-derives it on demand (settings "Refresh" grammar:
                      RiRefreshLine spinning while in flight). */}
                  {section.label === "Free" ? (
                    <button
                      type="button"
                      aria-label="Refresh free models"
                      title="Refresh"
                      disabled={refreshing}
                      onClick={() => void handleRefresh()}
                      className="text-text-tertiary hover:text-text-primary mr-1 rounded-md p-1 transition-colors disabled:opacity-50"
                    >
                      <RiRefreshLine
                        className={cn("size-3.5", refreshing && "animate-spin")}
                        aria-hidden
                      />
                    </button>
                  ) : null}
                </div>
                {section.options.map((e) => {
                  const selected = e.value === model;
                  return (
                    <button
                      key={e.value}
                      type="button"
                      onClick={() => {
                        onChange(e.value);
                        setOpen(false);
                      }}
                      className="hover:bg-background-primary-hover flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors"
                    >
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center",
                          selected ? "text-orange-500" : "text-transparent",
                        )}
                      >
                        <RiCheckLine className="size-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-body-2-medium text-text-primary block">
                          {e.label}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
