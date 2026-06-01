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
// - Presentation rides the BoardUI base Notification card (semantic
//   notification-* tokens, so it follows every theme) instead of the original
//   raw yellow ramp; BoardUI ships no warning status, so the advisory uses
//   `information`.

import { Notification } from "@/components/base/notification/notification";
import { ENGINES, type EngineId } from "@/components/chat/types";

/**
 * The display label to warn about, or null when there is nothing honest to say:
 * the manifest lists the engine, or readiness has not resolved yet. The engine
 * hook uses a conservative OpenCode-only fallback while loading, so the
 * explicit readiness bit—not the fallback contents—distinguishes unknown state.
 */
export function unavailableEngineLabel(
  engine: EngineId,
  enabledEngines: readonly EngineId[],
  readinessKnown: boolean,
): string | null {
  if (!readinessKnown) return null;
  if (enabledEngines.includes(engine)) return null;
  return ENGINES.find((e) => e.id === engine)?.label ?? engine;
}

/**
 * Provider-status notice: the thread's engine is missing from the server's
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
    <div data-session-ui="provider-status-banner">
      <Notification
        role="alert"
        status="information"
        title={`${engineLabel} is unavailable`}
        description={`${engineLabel} is currently unavailable on this server. Replies that use this engine may fail until it returns.`}
        dismissible={Boolean(onDismiss)}
        closeLabel={`Dismiss ${engineLabel} status`}
        onDismiss={onDismiss}
      />
    </div>
  );
}
