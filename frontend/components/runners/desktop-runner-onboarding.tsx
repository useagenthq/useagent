"use client";

import { useEffect, useState } from "react";
import {
  type DesktopRunnerStatus,
  desktopBridge,
  localRunnerAvailable,
  type UseAgentDesktopBridge,
} from "./desktop-bridge";

export function DesktopRunnerOnboarding() {
  const [bridge, setBridge] = useState<UseAgentDesktopBridge | null>(null);
  const [status, setStatus] = useState<DesktopRunnerStatus | null>(null);
  useEffect(() => setBridge(desktopBridge()), []);
  useEffect(() => {
    if (!bridge || !localRunnerAvailable(bridge.platform)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await bridge.runnerStatus();
        if (cancelled) return;
        setStatus(next);
        if (next.state === "starting" || next.state === "pulling") timer = setTimeout(poll, 750);
      } catch {
        if (!cancelled) setStatus({ state: "error", detail: "Could not read runner status." });
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [bridge]);

  if (!bridge || !localRunnerAvailable(bridge.platform) || !status || (status.state !== "starting" && status.state !== "pulling")) return null;
  const progress =
    status.state === "pulling" && typeof status.progress === "number"
      ? Math.max(0, Math.min(100, Math.round(status.progress * 100)))
      : null;
  return (
    <aside
      className="fixed bottom-4 right-4 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-border-button-default bg-background-primary-default p-4 shadow-dropdown"
      aria-live="polite"
    >
      <p className="text-body-2-medium text-text-primary">Preparing this machine</p>
      <p className="mt-1 text-caption-1-regular text-text-secondary">
        {status.detail ||
          (status.state === "pulling"
            ? "Pulling the runner image"
            : "Detecting a container backend")}
      </p>
      {progress !== null ? (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-background-tertiary-default"
          role="progressbar"
          aria-label="Desktop setup"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div className="h-full rounded-full bg-accent-500" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
    </aside>
  );
}
