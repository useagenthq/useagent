"use client";

import { RiLoader4Line } from "@remixicon/react";

import { useWorkingSignal } from "./working-signal";

export function WorkingProjectStatus() {
  const working = useWorkingSignal();
  if (!working) return null;

  return (
    <span className="inline-flex items-center gap-1 text-paragraph-xs text-sky-500" role="status">
      <RiLoader4Line className="size-3.5 animate-spin" aria-hidden />
      Working
    </span>
  );
}
