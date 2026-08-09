"use client";

import { useEffect, useState } from "react";
import { RiArrowDownSLine, RiCheckLine, RiCpuLine } from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";
import { ENGINES, MODELS, modelLabel, type EngineId } from "@/components/chat/types";

/**
 * Which agent engines the SERVER actually allows, from GET /api/config -> `engines`
 * (gated by ENABLED_ENGINES). Defaults to just OpenCode until the fetch resolves, so
 * the composer never offers claude/codex on a backend that would 403 them. This is
 * the capability-driven source of truth for the engine picker (final_harness Phase 2).
 */
export function useEnabledEngines(): EngineId[] {
  const [engines, setEngines] = useState<EngineId[]>(["opencode"]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/config");
        if (!res.ok) return;
        const j = (await res.json()) as { engines?: unknown };
        if (cancelled || !Array.isArray(j.engines)) return;
        const ids = j.engines.filter(
          (e): e is EngineId => typeof e === "string" && ENGINES.some((x) => x.id === e),
        );
        if (ids.length) setEngines(ids);
      } catch {
        // network/backend down: keep the safe OpenCode-only default.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return engines;
}

/**
 * The `✳ <engine> ⌄` model picker from the HeyRico hero — an orange asterisk +
 * the current engine label + a dropdown of the sandbox engines. This is the
 * engine selector integrated "next to the model" per spec.
 */
export function ModelPicker({
  model,
  onChange,
  className,
}: {
  model: string;
  onChange: (model: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        data-testid="model-picker"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-text-strong-950 hover:bg-bg-weak-50 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-label-sm transition-colors"
      >
        {/* Engine chip glyph — the AsteriskMark is Skynet's brand, not an
            engine's; match the composer's neutral cpu icon instead. */}
        <RiCpuLine className="text-text-sub-600 size-4" aria-hidden />
        <span>{modelLabel(model)}</span>
        <RiArrowDownSLine className="text-text-soft-400 size-4" aria-hidden />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" aria-hidden onClick={() => setOpen(false)} />
          <div className="border-stroke-soft-200 bg-bg-white-0 shadow-regular-md absolute bottom-11 right-0 z-20 w-56 rounded-2xl border p-1.5">
            <p className="text-mono-label text-text-soft-400 px-2 pb-1 pt-1.5">Model</p>
            {MODELS.map((e) => {
              const selected = e.value === model;
              return (
                <button
                  key={e.value}
                  type="button"
                  onClick={() => {
                    onChange(e.value);
                    setOpen(false);
                  }}
                  className="hover:bg-bg-weak-50 flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors"
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
                    <span className="text-label-sm text-text-strong-950 block">
                      {e.label}
                    </span>
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
