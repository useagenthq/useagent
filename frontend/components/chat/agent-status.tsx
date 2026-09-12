"use client";


import {
  RiCheckLine,
  RiErrorWarningLine,
} from "@remixicon/react";
import { useEffect, useState } from "react";
import {
  type MergedChildFidelity,
} from "@/components/chat/canonical-children";
import type { ChildStatus } from "@/components/chat/native-events";
import type { SubagentCard } from "@/components/chat/subagents";
export function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

/** Elapsed ms this card has been (or was) active; frozen once it settles. */
export function childElapsedMs(
  card: SubagentCard,
  now: number,
  live: boolean,
  providerDurationMs: number | null,
): number | null {
  if (!live && providerDurationMs !== null && Number.isFinite(providerDurationMs) && providerDurationMs > 0) {
    return providerDurationMs;
  }
  // Canonical translation currently falls back to the provider sequence when no
  // wall-clock timestamp exists. Never present that sequence delta as a duration.
  if (!Number.isFinite(card.startedAt) || card.startedAt < Date.UTC(2000, 0, 1)) return null;
  const endedAt = live ? now : (card.lastActivityAt ?? card.startedAt);
  const elapsed = Math.max(0, endedAt - card.startedAt);
  return elapsed > 0 ? elapsed : null;
}

export const isChildActive = (status: ChildStatus): boolean =>
  status === "pending" || status === "running" || status === "waiting";

export const childStatusLabel = (status: ChildStatus, resumable: boolean | null = null): string => {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "idle":
      return resumable === false ? "Idle" : "Idle · resumable";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    default:
      status satisfies never;
      return "Unknown";
  }
};

export type RailChildFidelity = MergedChildFidelity;

export function ChildStateDot({ status }: { status: ChildStatus }) {
  if (isChildActive(status)) {
    return (
      <span
        className="ai-loading-pixel bg-blue-500 size-1.5 shrink-0 rounded-full"
        role="status"
        aria-label="running"
      />
    );
  }
  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    return <RiErrorWarningLine className="text-red-500 size-4 shrink-0" aria-label="failed" />;
  }
  return <RiCheckLine className="text-lime-600 size-4 shrink-0" aria-label="completed" />;
}
