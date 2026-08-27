"use client";

import { RiArrowDownSLine, RiCheckLine, RiCpuLine, RiRefreshLine } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import {
  ENGINES,
  type EngineId,
  modelLabel,
  modelOptionsForEngine,
  partitionModelOptions,
  selectableModelsForEngine,
} from "@/components/chat/types";
import { cx as cn } from "@/utils/cx";

export type EngineModelCatalog = Partial<Record<EngineId, readonly string[]>>;

export function resolveEnabledEngine(
  current: EngineId,
  enabled: readonly EngineId[],
): EngineId | null {
  if (enabled.includes(current)) return current;
  return enabled[0] ?? null;
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
    const j = (await res.json()) as { models?: unknown };
    return parseEngineModelCatalog(j.models);
  } catch {
    return null;
  }
}

export function useEnabledEngineConfig(): {
  engines: EngineId[];
  models: EngineModelCatalog;
  /** True once GET /api/config resolved (or failed): before that the engines
   * list is the conservative fallback and must not demote a richer default. */
  loaded: boolean;
  /** True only when the server returned an engines manifest. */
  readinessKnown: boolean;
  /** Manual Free-lane refresh: swaps the refreshed manifest in place; a failed
   * or rate-limited request keeps the current catalog. */
  refreshModels: () => Promise<void>;
} {
  const [config, setConfig] = useState<{
    engines: EngineId[];
    models: EngineModelCatalog;
    loaded: boolean;
    readinessKnown: boolean;
  }>({
    engines: ["opencode"],
    models: { opencode: selectableModelsForEngine("opencode").map((m) => m.value) },
    loaded: false,
    readinessKnown: false,
  });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/config");
        if (!res.ok) return;
        const j = (await res.json()) as { engines?: unknown; models?: unknown };
        if (cancelled) return;
        const engines = Array.isArray(j.engines)
          ? j.engines.filter(
              (e): e is EngineId => typeof e === "string" && ENGINES.some((x) => x.id === e),
            )
          : [];
        if (engines.length) {
          setConfig({
            engines,
            models: parseEngineModelCatalog(j.models),
            loaded: true,
            readinessKnown: true,
          });
        } else {
          setConfig((c) => ({
            ...c,
            loaded: true,
            readinessKnown: Array.isArray(j.engines),
          }));
        }
      } catch {
        // network/backend down: keep the safe OpenCode-only default, but mark
        // the manifest resolved so the composer can settle its engine choice.
        setConfig((c) => ({ ...c, loaded: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const refreshModels = useCallback(async () => {
    const models = await requestModelCatalogRefresh();
    if (!models || Object.keys(models).length === 0) return;
    setConfig((c) => ({ ...c, models: { ...c.models, ...models } }));
  }, []);
  return { ...config, refreshModels };
}

/**
 * Which agent engines the SERVER actually allows, from GET /api/config -> `engines`
 * (gated by ENABLED_ENGINES). Defaults to just OpenCode until the fetch resolves, so
 * the composer never offers claude/codex on a backend that would 403 them. This is
 * the capability-driven source of truth for the engine picker.
 */
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
  const models = modelOptionsForEngine(engine, modelCatalog[engine]);
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
      await refreshModels();
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
        className="text-text-primary hover:bg-background-primary-hover flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-body-2-medium transition-colors"
      >
        {/* Engine chip glyph — the AsteriskMark is useAgent's brand, not an
            engine's; match the composer's neutral cpu icon instead. */}
        <RiCpuLine className="text-text-secondary size-4" aria-hidden />
        <span>{modelLabel(model, engine)}</span>
        <RiArrowDownSLine className="text-text-tertiary size-4" aria-hidden />
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
