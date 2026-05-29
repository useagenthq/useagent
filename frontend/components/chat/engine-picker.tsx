"use client";

import { RiArrowDownSLine, RiCheckLine, RiCpuLine } from "@remixicon/react";
import { useEffect, useState } from "react";
import {
  ENGINES,
  type EngineId,
  modelLabel,
  modelOptionsForEngine,
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

export function useEnabledEngineConfig(): {
  engines: EngineId[];
  models: EngineModelCatalog;
} {
  const [config, setConfig] = useState<{
    engines: EngineId[];
    models: EngineModelCatalog;
  }>({
    engines: ["opencode"],
    models: { opencode: selectableModelsForEngine("opencode").map((m) => m.value) },
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
        if (engines.length) setConfig({ engines, models: parseEngineModelCatalog(j.models) });
      } catch {
        // network/backend down: keep the safe OpenCode-only default.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}

/**
 * Which agent engines the SERVER actually allows, from GET /api/config -> `engines`
 * (gated by ENABLED_ENGINES). Defaults to just OpenCode until the fetch resolves, so
 * the composer never offers claude/codex on a backend that would 403 them. This is
 * the capability-driven source of truth for the engine picker (final_harness Phase 2).
 */
export function useEnabledEngines(): EngineId[] {
  return useEnabledEngineConfig().engines;
}

export function useEngineModelCatalog(): EngineModelCatalog {
  return useEnabledEngineConfig().models;
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
  const modelCatalog = useEngineModelCatalog();
  const models = modelOptionsForEngine(engine, modelCatalog[engine]);

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
            <p className="text-mono-label text-text-tertiary px-2 pb-1 pt-1.5">Model</p>
            {models.map((e) => {
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
                    <span className="text-body-2-medium text-text-primary block">{e.label}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
