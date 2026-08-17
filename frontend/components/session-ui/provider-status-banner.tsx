"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/chat/ProviderStatusBanner.tsx (the slim
// degraded-provider notice: info glyph + provider name + honest status message
// + dismiss control).
//
// Port notes:
// - Upstream renders a rich ServerProvider health object (status/auth/message).
//   Our manifest (GET /api/config -> `engines`, already fetched by
//   useEnabledEngineConfig in engine-picker.tsx - NO new fetch here) is thinner:
//   the backend publishes only READY engines (readyUserFacingEngines), so the
//   one honest degraded signal is "the selected engine is missing from the
//   manifest". `unavailableEngineLabel` computes exactly that; the wording says
//   "may fail", never a certainty the manifest cannot back.
// - Their shadcn/lucide chrome -> AlignUI warning tokens + Remixicon, matching
//   the other session-ui ports.

import { RiCloseLine, RiInformationLine } from "@remixicon/react";
import { ENGINES, type EngineId } from "@/components/chat/types";

/**
 * The display label to warn about, or null when there is nothing honest to say:
 * the manifest lists the engine, or the manifest is EMPTY (not resolved yet -
 * an unknown manifest must never flag an engine as unavailable).
 */
export function unavailableEngineLabel(
  engine: EngineId,
  enabledEngines: readonly EngineId[],
): string | null {
  if (enabledEngines.length === 0) return null;
  if (enabledEngines.includes(engine)) return null;
  return ENGINES.find((e) => e.id === engine)?.label ?? engine;
}

/**
 * Slim provider-status banner: the thread's engine is missing from the server's
 * ready-engines manifest. Purely presentational; the call site passes the
 * computed label (see unavailableEngineLabel).
 */
export function ProviderStatusBanner({
  engineLabel,
  onDismiss,
}: {
  /** Display label of the unavailable engine (from unavailableEngineLabel). */
  engineLabel: string;
  onDismiss?: () => void;
}) {
  return (
    <div
      data-session-ui="provider-status-banner"
      role="alert"
      className="border-warning-light bg-warning-lighter text-warning-base flex items-center gap-2 rounded-xl border px-3 py-2"
    >
      <RiInformationLine className="size-4 shrink-0" aria-hidden />
      <p className="text-paragraph-xs min-w-0 flex-1">
        {engineLabel} is currently unavailable on this server. Replies that use this engine may
        fail until it returns.
      </p>
      {onDismiss && (
        <button
          type="button"
          aria-label={`Dismiss ${engineLabel} status`}
          onClick={onDismiss}
          className="text-warning-base hover:bg-warning-light/40 flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
        >
          <RiCloseLine className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
