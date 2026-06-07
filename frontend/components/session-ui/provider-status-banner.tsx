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
//   Our manifest now keeps configured engines visible and carries a separate
//   readiness map. This component consumes that already-fetched state (no new
//   request) and shows the backend's actionable provider detail.
// - Presentation rides the BoardUI base Notification card (semantic
//   notification-* tokens, so it follows every theme) instead of the original
//   raw yellow ramp; BoardUI ships no warning status, so the advisory uses
//   `information`.

import { Notification } from "@/components/base/notification/notification";
import type { EngineReadinessCatalog } from "@/components/chat/engine-picker";
import { ENGINES, type EngineId } from "@/components/chat/types";

/**
 * The display label to warn about, or null when there is nothing honest to say.
 * A configured engine can be listed and still need attention; the explicit
 * readiness map distinguishes that from the conservative loading fallback.
 */
export function unavailableEngineLabel(
  engine: EngineId,
  enabledEngines: readonly EngineId[],
  readinessKnown: boolean,
  readiness: EngineReadinessCatalog = {},
): string | null {
  if (!readinessKnown) return null;
  if (enabledEngines.includes(engine) && readiness[engine]?.ready !== false) return null;
  return ENGINES.find((e) => e.id === engine)?.label ?? engine;
}

/**
 * Provider-status notice for a missing or configured-but-unready engine.
 */
export function ProviderStatusBanner({
  engineLabel,
  description,
  onDismiss,
}: {
  /** Display label of the unavailable engine (from unavailableEngineLabel). */
  engineLabel: string;
  description?: string;
  onDismiss?: () => void;
}) {
  return (
    <div data-session-ui="provider-status-banner">
      <Notification
        role="alert"
        status="information"
        title={`${engineLabel} is unavailable`}
        description={description ?? `${engineLabel} is currently unavailable on this server. Replies that use this engine may fail until it returns.`}
        dismissible={Boolean(onDismiss)}
        closeLabel={`Dismiss ${engineLabel} status`}
        onDismiss={onDismiss}
      />
    </div>
  );
}
