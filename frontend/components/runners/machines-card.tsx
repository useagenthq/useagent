"use client";

import { RiComputerLine, RiLoader4Line, RiRefreshLine } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { Switch } from "@/components/base/switch/switch";
import {
  connectDesktopRunner,
  type DesktopRunnerStatus,
  desktopBridge,
  localRunnerAvailable,
  machineLabel,
  resolveRunnerPlatform,
  runnerConnectionAction,
  type UseAgentDesktopBridge,
} from "./desktop-bridge";
import { canRevokeRunner, type Runner, type RunnerPolicy } from "./runner-data";
import { useRunnerSettings } from "./runner-settings-context";

function RunnerStatusChip({ status }: { readonly status: Runner["status"] }) {
  const color = status === "online" ? "lime" : status === "revoked" ? "rose" : "soft";
  return (
    <Chip color={color} className="capitalize">
      {status}
    </Chip>
  );
}

function value(value: string | null): string {
  return value?.trim() || "Not reported";
}

function MachineRow({ runner }: { readonly runner: Runner }) {
  const { canManagePolicy, revoke, userId } = useRunnerSettings();
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start">
      <RiComputerLine
        aria-hidden
        className="mt-0.5 size-5 shrink-0 text-foreground-icon-tertiary"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-body-2-medium text-text-primary">{runner.name}</p>
          <RunnerStatusChip status={runner.status} />
        </div>
        <dl className="mt-2 grid gap-x-5 gap-y-1 text-caption-1-regular sm:grid-cols-2">
          <div>
            <dt className="inline text-text-tertiary">Backend: </dt>
            <dd className="inline text-text-secondary">{value(runner.backend)}</dd>
          </div>
          <div>
            <dt className="inline text-text-tertiary">Version: </dt>
            <dd className="inline text-text-secondary">{value(runner.version)}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="inline text-text-tertiary">Image: </dt>
            <dd className="break-all font-mono text-text-secondary">{value(runner.imageDigest)}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="inline text-text-tertiary">Logins: </dt>
            <dd className="inline text-text-secondary">
              {runner.logins.length ? runner.logins.join(", ") : "None reported"}
            </dd>
          </div>
        </dl>
        {error ? (
          <p role="alert" className="mt-2 text-caption-1-regular text-text-error-primary">
            Could not revoke this machine.
          </p>
        ) : null}
      </div>
      {canRevokeRunner(runner, userId, canManagePolicy) ? (
        <Button
          variant="danger"
          size="xs"
          className="rounded-full self-start"
          disabled={revoking}
          onClick={() => {
            setRevoking(true);
            setError(false);
            void revoke(runner.id)
              .catch(() => setError(true))
              .finally(() => setRevoking(false));
          }}
        >
          Revoke
        </Button>
      ) : null}
    </div>
  );
}

function DesktopConnection({ bridge }: { readonly bridge: UseAgentDesktopBridge }) {
  const { load } = useRunnerSettings();
  const [platform, setPlatform] = useState<Awaited<ReturnType<typeof resolveRunnerPlatform>>>(null);
  const [resolved, setResolved] = useState(false);
  const [status, setStatus] = useState<DesktopRunnerStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [monitoring, setMonitoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveRunnerPlatform(bridge.platform).then((value) => {
      if (!cancelled) {
        setPlatform(value);
        setResolved(true);
      }
    });
    void bridge
      .runnerStatus()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {
        if (!cancelled) setError("Could not read runner status. Refresh the page to retry.");
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  useEffect(() => {
    if (!monitoring) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await bridge.runnerStatus();
        if (cancelled) return;
        setStatus(next);
        if (next.state === "online") {
          setMonitoring(false);
          await load();
          return;
        }
        if (next.state === "error") {
          setMonitoring(false);
          setError(next.detail || "The local runner could not start.");
          return;
        }
      } catch {
        if (!cancelled) {
          setMonitoring(false);
          setError("Could not read the local runner status.");
        }
        return;
      }
      if (!cancelled) timer = setTimeout(poll, 750);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [bridge, load, monitoring]);

  const connect = useCallback(async () => {
    if (!platform) return;
    setConnecting(true);
    setError(null);
    try {
      await connectDesktopRunner(bridge, platform);
      setMonitoring(true);
    } catch {
      setError("Could not connect this machine.");
    } finally {
      setConnecting(false);
    }
  }, [bridge, platform]);

  const progress =
    status?.state === "pulling" && typeof status.progress === "number"
      ? Math.max(0, Math.min(100, Math.round(status.progress * 100)))
      : null;
  const action = runnerConnectionAction(status, bridge.platform);

  return (
    <div className="rounded-xl border border-border-button-default bg-background-secondary-default p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-body-2-medium text-text-primary">{machineLabel(bridge.platform)}</p>
          <p className="text-caption-1-regular text-text-tertiary">
            Desktop {bridge.version}
            {status ? ` - ${status.detail || status.state}` : ""}
          </p>
        </div>
        <Button
          className="rounded-full self-start"
          size="small"
          disabled={!resolved || !platform || connecting || monitoring || action.active}
          leadingIcon={connecting || monitoring ? RiLoader4Line : undefined}
          onClick={() => void connect()}
        >
          {action.label}
        </Button>
      </div>
      {progress !== null ? (
        <div className="mt-3">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-background-tertiary-default"
            role="progressbar"
            aria-label="Runner image pull"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div className="h-full rounded-full bg-accent-500" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 text-caption-1-regular text-text-secondary">
            Pulling runner image, {progress}%
          </p>
        </div>
      ) : null}
      {resolved && !platform ? (
        <p role="alert" className="mt-2 text-caption-1-regular text-status-yellow-text">
          This desktop version does not report a reliable CPU architecture, so enrolment is
          unavailable.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PolicySwitch({
  field,
  label,
  policy,
}: {
  readonly field: keyof RunnerPolicy;
  readonly label: string;
  readonly policy: RunnerPolicy;
}) {
  const { savePolicy } = useRunnerSettings();
  const [saving, setSaving] = useState(false);
  return (
    <Switch
      aria-label={label}
      isSelected={policy[field]}
      isDisabled={saving}
      onChange={(selected) => {
        setSaving(true);
        void savePolicy({ [field]: selected })
          .catch(() => undefined)
          .finally(() => setSaving(false));
      }}
      size="sm"
    />
  );
}

export function MachinesCard() {
  const { canManagePolicy, error, load, loading, policy, runners } = useRunnerSettings();
  const [bridge, setBridge] = useState<UseAgentDesktopBridge | null>(null);
  useEffect(() => setBridge(desktopBridge()), []);

  return (
    <div className="flex flex-col gap-4">
      {bridge && localRunnerAvailable(bridge.platform) ? <DesktopConnection bridge={bridge} /> : null}
      <div className="flex items-center justify-between gap-3">
        <p className="text-caption-1-regular text-text-secondary">
          {loading
            ? "Loading machines..."
            : `${runners.length} machine${runners.length === 1 ? "" : "s"}`}
        </p>
        <Button
          variant="secondary"
          size="xs"
          className="rounded-full"
          leadingIcon={RiRefreshLine}
          onClick={() => void load()}
        >
          Refresh
        </Button>
      </div>
      {runners.length ? (
        <div className="divide-y divide-separator-border rounded-xl border border-border-button-default bg-background-secondary-default p-4">
          {runners.map((runner) => (
            <MachineRow key={runner.id} runner={runner} />
          ))}
        </div>
      ) : !loading ? (
        <p className="rounded-xl border border-border-button-default bg-background-secondary-default p-4 text-caption-1-regular text-text-tertiary">
          No machines enrolled.
        </p>
      ) : null}
      {policy ? (
        <div className="divide-y divide-separator-border rounded-xl border border-border-button-default bg-background-secondary-default px-4">
          <div className="flex items-center justify-between gap-4 py-3">
            <div>
              <p className="text-body-2-medium text-text-primary">Allow local execution</p>
              <p className="text-caption-1-regular text-text-tertiary">
                Let eligible threads run on enrolled machines.
              </p>
            </div>
            {canManagePolicy ? (
              <PolicySwitch
                field="allowLocalExecution"
                label="Allow local execution"
                policy={policy}
              />
            ) : (
              <Chip color="soft">{policy.allowLocalExecution ? "On" : "Off"}</Chip>
            )}
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <div>
              <p className="text-body-2-medium text-text-primary">Allow local logins</p>
              <p className="text-caption-1-regular text-text-tertiary">
                Allow reported machine logins to be used by supported engines.
              </p>
            </div>
            {canManagePolicy ? (
              <PolicySwitch field="allowLocalLogins" label="Allow local logins" policy={policy} />
            ) : (
              <Chip color="soft">{policy.allowLocalLogins ? "On" : "Off"}</Chip>
            )}
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      ) : null}
    </div>
  );
}
