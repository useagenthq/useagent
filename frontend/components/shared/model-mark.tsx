import { RiOpenaiFill } from "@remixicon/react";
import type { ComponentType } from "react";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";

export interface ModelStyle {
  Mark: ComponentType<{ className?: string }>;
  markClass: string;
  /** Tailwind bg-* class for a filled meter segment. */
  fill: string;
}

/**
 * Icon + meter tone keyed off a real model slug. Cosmetic ONLY (the mark/color;
 * the numbers a caller renders alongside are always real). Falls back to the
 * brand mark for any unrecognised model. Shared by the workspace "Limits" card
 * and the Settings usage meters so both read a model the same way.
 */
export function modelStyle(model: string): ModelStyle {
  const m = model.toLowerCase();
  if (m.includes("gpt") || m.includes("openai")) {
    return { Mark: RiOpenaiFill, markClass: "text-text-strong-950", fill: "bg-text-strong-950" };
  }
  if (m.includes("opus")) return { Mark: AsteriskMark, markClass: "text-orange-500", fill: "bg-orange-400" };
  if (m.includes("sonnet")) return { Mark: AsteriskMark, markClass: "text-blue-500", fill: "bg-blue-400" };
  if (m.includes("haiku")) return { Mark: AsteriskMark, markClass: "text-green-500", fill: "bg-green-400" };
  return { Mark: AsteriskMark, markClass: "text-primary-base", fill: "bg-primary-base" };
}
