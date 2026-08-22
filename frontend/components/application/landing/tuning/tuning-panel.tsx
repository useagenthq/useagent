"use client";

import { useState } from "react";
import { RiCloseLine, RiFileCopyLine, RiRefreshLine, RiSettings3Line } from "@remixicon/react";
import type { TuningValues } from "@/components/application/landing/tuning/tuning-store";
import { cx } from "@/utils/cx";

/**
 * TEMPORARY tuning panel, shared by the ray shader and the glass material.
 *
 * Deliberately built from raw inputs rather than the design system: it is a
 * scratch tool that should leave with the tuning session, and wiring it into
 * the component library would make it look permanent. Delete this directory —
 * and the panel branch in `hero-shader.tsx` — once the numbers are settled.
 *
 * "Copy config" yields a pasteable defaults block, which is how a session's
 * worth of dragging becomes a committed default.
 */

export type TuningControl =
  | {
      key: string;
      label: string;
      type: "range";
      min: number;
      max: number;
      step: number;
      hint: string;
    }
  | { key: string; label: string; type: "color"; hint: string };

export type TuningGroup = { title: string; controls: TuningControl[] };

export type TuningSection = {
  /** Tab id, unique across sections. */
  id: string;
  label: string;
  groups: TuningGroup[];
  values: TuningValues;
  /** Key order for the copied source block. */
  order: string[];
  presets?: Record<string, TuningValues>;
  /** Names used in the copied block, e.g. `HERO_RAYS_DEFAULTS` / `HeroRaysConfig`. */
  constName: string;
  typeName: string;
  onChange: (patch: TuningValues) => void;
  onReset: () => void;
};

function formatValue(value: number) {
  if (Number.isInteger(value)) return String(value);
  return value
    .toFixed(Math.abs(value) < 0.1 ? 4 : 3)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

function toSource(section: TuningSection) {
  const lines = section.order.map((key) => {
    const value = section.values[key];
    return `  ${key}: ${typeof value === "string" ? `"${value}"` : value},`;
  });
  return `export const ${section.constName}: ${section.typeName} = {\n${lines.join("\n")}\n};`;
}

export function TuningPanel({ sections }: { sections: TuningSection[] }) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");
  const [copied, setCopied] = useState(false);

  const active = sections.find((section) => section.id === activeId) ?? sections[0];
  if (!active) return null;

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(toSource(active));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard is blocked outside a secure context — put it somewhere the
      // numbers can still be rescued from.
      console.info(toSource(active));
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-4 bottom-4 z-[60] flex items-center gap-2 rounded-full border border-white/15 bg-black/80 px-4 py-2.5 text-[13px] font-medium text-white shadow-xl backdrop-blur transition hover:bg-black"
      >
        <RiSettings3Line className="size-4" />
        Tune
      </button>
    );
  }

  return (
    <div className="fixed right-4 bottom-4 z-[60] flex max-h-[calc(100vh-2rem)] w-[336px] flex-col rounded-2xl border border-white/12 bg-[#0a0c11]/95 text-white shadow-2xl backdrop-blur-xl">
      <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3.5 py-3">
        <div className="flex items-center gap-1 rounded-lg bg-white/8 p-0.5">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => setActiveId(section.id)}
              className={cx(
                "rounded-md px-2.5 py-1 text-[12px] font-medium transition",
                section.id === active.id
                  ? "bg-white text-black"
                  : "text-white/70 hover:text-white",
              )}
            >
              {section.label}
            </button>
          ))}
        </div>

        {active.presets ? (
          <select
            value=""
            onChange={(event) => {
              const preset = active.presets?.[event.target.value];
              if (preset) active.onChange(preset);
            }}
            className="ml-auto rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-[12px] text-white/90 outline-none"
          >
            <option value="">Preset…</option>
            {Object.keys(active.presets).map((name) => (
              <option key={name} value={name} className="bg-[#0a0c11]">
                {name}
              </option>
            ))}
          </select>
        ) : null}

        <button
          type="button"
          onClick={() => setOpen(false)}
          className={cx(
            "rounded-lg p-1 text-white/60 transition hover:bg-white/10 hover:text-white",
            active.presets ? "" : "ml-auto",
          )}
          aria-label="Close tuning panel"
        >
          <RiCloseLine className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {active.groups.map((group) => (
          <section key={group.title} className="mb-4 last:mb-0">
            <h3 className="mb-2 text-[10px] font-semibold tracking-[0.12em] text-white/40 uppercase">
              {group.title}
            </h3>

            <div className="flex flex-col gap-2.5">
              {group.controls.map((control) => (
                <label key={control.key} className="block" title={control.hint}>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] text-white/75">{control.label}</span>
                    <span className="font-mono text-[11px] text-white/45 tabular-nums">
                      {control.type === "color"
                        ? String(active.values[control.key])
                        : formatValue(Number(active.values[control.key]))}
                    </span>
                  </span>

                  {control.type === "color" ? (
                    <input
                      type="color"
                      value={String(active.values[control.key])}
                      onChange={(event) =>
                        active.onChange({ [control.key]: event.target.value })
                      }
                      className="mt-1 h-7 w-full cursor-pointer rounded-md border border-white/15 bg-transparent"
                    />
                  ) : (
                    <input
                      type="range"
                      min={control.min}
                      max={control.max}
                      step={control.step}
                      value={Number(active.values[control.key])}
                      onChange={(event) =>
                        active.onChange({ [control.key]: Number(event.target.value) })
                      }
                      className="mt-1 w-full cursor-pointer accent-[#7aa2ff]"
                    />
                  )}
                </label>
              ))}
            </div>
          </section>
        ))}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-white/10 px-3.5 py-2.5">
        <button
          type="button"
          onClick={copyConfig}
          className={cx(
            "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium transition",
            copied ? "bg-lime-400 text-black" : "bg-white text-black hover:bg-white/90",
          )}
        >
          <RiFileCopyLine className="size-3.5" />
          {copied ? "Copied" : `Copy ${active.label.toLowerCase()}`}
        </button>
        <button
          type="button"
          onClick={active.onReset}
          className="rounded-lg border border-white/15 p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white"
          aria-label={`Reset ${active.label} to defaults`}
        >
          <RiRefreshLine className="size-3.5" />
        </button>
      </footer>
    </div>
  );
}
