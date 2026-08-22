"use client";

import type {
  TuningGroup,
  TuningSection,
} from "@/components/application/landing/tuning/tuning-panel";
import { createTuningStore } from "@/components/application/landing/tuning/tuning-store";
import { useThemeMode } from "@/components/application/theme/theme-toggle";
import { useSyncExternalStore } from "react";

/**
 * Every knob of the liquid glass material.
 *
 * The rim is the interesting part. It is a conic gradient standing in for a
 * bevel, and it has two independent sources of colour:
 *
 *   - the gradient's own stops (`rimHighlight` / `rimShadow` / `rimBounce`),
 *     which is the ring you see travelling around the edge, and
 *   - `dispersion`, which splits the refracted backdrop into R/G/B at slightly
 *     different displacement scales. That is what puts a *rainbow* at the rim,
 *     and it is not the stroke — turning the stroke white will not remove it.
 *     Set `dispersion` to 0 for a colourless edge.
 */

export type GlassConfig = {
  // Material
  frost: number;
  saturate: number;
  refraction: number;
  depth: number;
  splay: number;
  dispersion: number;

  // Tint
  tintColor: string;
  tintOpacity: number;

  // Sheen
  sheenColor: string;
  sheenOpacity: number;
  sheenAngle: number;

  // Rim
  rimWidth: number;
  rimAngle: number;
  rimOpacity: number;
  rimHighlight: string;
  rimHighlightOpacity: number;
  rimShadow: string;
  rimShadowOpacity: number;
  rimBounce: string;
  rimBounceOpacity: number;

  // Drop shadow
  shadowColor: string;
  shadowOpacity: number;
  shadowBlur: number;
  shadowY: number;

  // Hover — every value the resting state has, plus movement
  hoverMs: number;
  hoverTintOpacity: number;
  hoverSheenOpacity: number;
  hoverRimOpacity: number;
  hoverLift: number;
  hoverScale: number;
  hoverShadowOpacity: number;
  hoverShadowBlur: number;
  hoverShadowY: number;
};

export const GLASS_DEFAULTS: GlassConfig = {
  frost: 6,
  saturate: 160,
  refraction: 1,
  depth: 1,
  splay: 1.09,
  dispersion: 1.15,

  tintColor: "#ffffff",
  tintOpacity: 0.06,

  sheenColor: "#ffffff",
  sheenOpacity: 0.5,
  sheenAngle: 155,

  rimWidth: 0.3,
  rimAngle: 134,
  rimOpacity: 1,
  rimHighlight: "#000000",
  rimHighlightOpacity: 0.1,
  rimShadow: "#bababa",
  rimShadowOpacity: 0.38,
  rimBounce: "#ffffff",
  rimBounceOpacity: 0.48,

  shadowColor: "#000000",
  shadowOpacity: 0.045,
  shadowBlur: 13,
  shadowY: -2,

  hoverMs: 220,
  hoverTintOpacity: 0.28,
  hoverSheenOpacity: 0.68,
  hoverRimOpacity: 1,
  hoverLift: -2,
  hoverScale: 1,
  hoverShadowOpacity: 0.06,
  hoverShadowBlur: 20,
  hoverShadowY: 2,
};

export const GLASS_PRESETS: Record<string, GlassConfig> = {
  Default: GLASS_DEFAULTS,

  // No chromatic split anywhere — the edge reads as plain bevelled glass.
  Colourless: {
    ...GLASS_DEFAULTS,
    dispersion: 0,
    saturate: 100,
    rimHighlight: "#ffffff",
    rimShadow: "#000000",
    rimBounce: "#ffffff",
  },

  // Barely there: a hairline rim and almost no refraction.
  Whisper: {
    ...GLASS_DEFAULTS,
    frost: 6,
    refraction: 0.35,
    dispersion: 0,
    rimWidth: 1,
    rimHighlightOpacity: 0.55,
    rimShadowOpacity: 0.07,
    rimBounceOpacity: 0.3,
    tintOpacity: 0.1,
    sheenOpacity: 0.3,
  },

  // Thick, obvious lens — useful for seeing what each knob actually does.
  Heavy: {
    ...GLASS_DEFAULTS,
    frost: 1,
    refraction: 1.6,
    depth: 1.5,
    splay: 1.6,
    dispersion: 1.8,
    rimWidth: 2.5,
    rimHighlightOpacity: 1,
    rimShadowOpacity: 0.3,
    tintOpacity: 0.03,
    shadowOpacity: 0.12,
    shadowBlur: 28,
  },
};

const GLASS_GROUPS: TuningGroup[] = [
  {
    title: "Material",
    controls: [
      { key: "frost", label: "Frost", type: "range", min: 0, max: 24, step: 0.5, hint: "Backdrop blur in px, before refraction." },
      { key: "saturate", label: "Saturation", type: "range", min: 50, max: 300, step: 1, hint: "How much the backdrop's colour is pushed as it passes through." },
      { key: "refraction", label: "Refraction", type: "range", min: 0, max: 2.5, step: 0.01, hint: "How hard the backdrop bends at the rim. 0 is flat frosted glass." },
      { key: "depth", label: "Depth", type: "range", min: 0, max: 2.5, step: 0.01, hint: "Softness of the lens falloff — how thick the glass reads." },
      { key: "splay", label: "Splay", type: "range", min: 0, max: 2.5, step: 0.01, hint: "Width of the distorted band inside the edge." },
      { key: "dispersion", label: "Dispersion", type: "range", min: 0, max: 2.5, step: 0.01, hint: "THE RAINBOW. Splits the backdrop into R/G/B at the rim. 0 removes all colour fringing." },
    ],
  },
  {
    title: "Tint",
    controls: [
      { key: "tintColor", label: "Tint", type: "color", hint: "Flat colour laid over the whole pane." },
      { key: "tintOpacity", label: "Tint opacity", type: "range", min: 0, max: 0.6, step: 0.005, hint: "0 removes the tint entirely." },
    ],
  },
  {
    title: "Sheen",
    controls: [
      { key: "sheenColor", label: "Sheen", type: "color", hint: "The directional gloss across the face." },
      { key: "sheenOpacity", label: "Sheen opacity", type: "range", min: 0, max: 1, step: 0.01, hint: "0 removes the gloss." },
      { key: "sheenAngle", label: "Sheen angle", type: "range", min: 0, max: 360, step: 1, hint: "Direction the gloss runs across the face." },
    ],
  },
  {
    title: "Rim",
    controls: [
      { key: "rimWidth", label: "Rim width", type: "range", min: 0, max: 6, step: 0.1, hint: "Stroke thickness in px. 0 removes the rim." },
      { key: "rimAngle", label: "Rim angle", type: "range", min: 0, max: 360, step: 1, hint: "Rotates the whole bevel — moves the highlight around the edge." },
      { key: "rimOpacity", label: "Rim opacity", type: "range", min: 0, max: 1, step: 0.01, hint: "Master opacity for the whole stroke — lower it here to leave room for the hover boost." },
      { key: "rimHighlight", label: "Highlight", type: "color", hint: "The bright stop, where the light source hits." },
      { key: "rimHighlightOpacity", label: "Highlight opacity", type: "range", min: 0, max: 1, step: 0.01, hint: "Strength of the bright stop." },
      { key: "rimShadow", label: "Shading", type: "color", hint: "The dark stop, where the glass turns away." },
      { key: "rimShadowOpacity", label: "Shading opacity", type: "range", min: 0, max: 1, step: 0.01, hint: "Strength of the dark stop. 0 leaves a highlight-only rim." },
      { key: "rimBounce", label: "Bounce", type: "color", hint: "The weaker secondary highlight opposite the main one." },
      { key: "rimBounceOpacity", label: "Bounce opacity", type: "range", min: 0, max: 1, step: 0.01, hint: "Strength of that secondary highlight." },
    ],
  },
  {
    title: "Drop shadow",
    controls: [
      { key: "shadowColor", label: "Shadow", type: "color", hint: "Colour of the shadow seating the pill on the page. Shared with the hover shadow." },
      { key: "shadowOpacity", label: "Shadow opacity", type: "range", min: 0, max: 0.6, step: 0.005, hint: "0 removes the shadow." },
      { key: "shadowBlur", label: "Shadow blur", type: "range", min: 0, max: 60, step: 1, hint: "Blur radius in px." },
      { key: "shadowY", label: "Shadow Y", type: "range", min: -20, max: 30, step: 1, hint: "Vertical offset. 0 reads as an even glow." },
    ],
  },
  {
    title: "Hover",
    controls: [
      { key: "hoverMs", label: "Duration (ms)", type: "range", min: 0, max: 800, step: 10, hint: "How long the transition into and out of hover takes. 0 snaps." },
      { key: "hoverTintOpacity", label: "Tint opacity", type: "range", min: 0, max: 0.6, step: 0.005, hint: "Tint opacity while hovered — set equal to the resting value for no change." },
      { key: "hoverSheenOpacity", label: "Sheen opacity", type: "range", min: 0, max: 1, step: 0.01, hint: "Sheen opacity while hovered." },
      { key: "hoverRimOpacity", label: "Rim opacity", type: "range", min: 0, max: 1, step: 0.01, hint: "Whole-stroke opacity while hovered. Pairs with the resting Rim opacity above." },
      { key: "hoverLift", label: "Lift (px)", type: "range", min: -8, max: 8, step: 0.5, hint: "Vertical movement on hover. Negative rises." },
      { key: "hoverScale", label: "Scale", type: "range", min: 0.9, max: 1.1, step: 0.002, hint: "Scale on hover. 1 keeps the size." },
      { key: "hoverShadowOpacity", label: "Shadow opacity", type: "range", min: 0, max: 0.6, step: 0.005, hint: "Drop-shadow opacity while hovered." },
      { key: "hoverShadowBlur", label: "Shadow blur", type: "range", min: 0, max: 60, step: 1, hint: "Drop-shadow blur while hovered." },
      { key: "hoverShadowY", label: "Shadow Y", type: "range", min: -20, max: 30, step: 1, hint: "Drop-shadow offset while hovered." },
    ],
  },
];

/**
 * Dark theme. The material needs different numbers, not just different
 * colours: over a dark band the sheen reads as a grey wash rather than gloss,
 * and the rim needs pulling back or it draws a hard outline around every
 * control. Tuned separately for that reason.
 */
export const GLASS_DARK_DEFAULTS: GlassConfig = {
  ...GLASS_DEFAULTS,
  sheenOpacity: 0.12,
  sheenAngle: 150,
  rimOpacity: 0.67,
  rimBounceOpacity: 0.31,
};

export const glassLightStore = createTuningStore<GlassConfig>(
  "boardui:glass",
  GLASS_DEFAULTS,
);

export const glassDarkStore = createTuningStore<GlassConfig>(
  "boardui:glass-dark",
  GLASS_DARK_DEFAULTS,
);

/** The glass config for whichever theme is showing. */
export function useGlassConfig(): GlassConfig {
  const theme = useThemeMode();
  const store = theme === "dark" ? glassDarkStore : glassLightStore;
  return useSyncExternalStore(store.subscribe, store.get, store.getDefaults);
}

/**
 * One panel tab, bound to the active theme's store — switch the page theme and
 * the same tab tunes (and copies) the other set.
 */
export function glassTuningSection(theme: "light" | "dark", values: GlassConfig): TuningSection {
  const dark = theme === "dark";
  const store = dark ? glassDarkStore : glassLightStore;
  return {
    id: "glass",
    label: dark ? "Glass ◗" : "Glass",
    groups: GLASS_GROUPS,
    values,
    order: Object.keys(GLASS_DEFAULTS),
    presets: GLASS_PRESETS,
    constName: dark ? "GLASS_DARK_DEFAULTS" : "GLASS_DEFAULTS",
    typeName: "GlassConfig",
    onChange: (patch) => store.update(patch as Partial<GlassConfig>),
    onReset: () => store.reset(),
  };
}

/** `#rrggbb` + alpha → `rgb(r g b / a)`, for composing gradient stops. */
export function rgba(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((character) => character + character)
          .join("")
      : value;
  const int = Number.parseInt(full, 16);
  if (!Number.isFinite(int)) return `rgb(0 0 0 / ${alpha})`;
  return `rgb(${(int >> 16) & 255} ${(int >> 8) & 255} ${int & 255} / ${alpha})`;
}
