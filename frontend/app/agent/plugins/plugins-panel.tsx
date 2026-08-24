"use client";

import { useEffect, useState } from "react";
import {
  RiDatabase2Line,
  RiGithubFill,
  RiGoogleFill,
  RiKey2Line,
  RiPlugLine,
  RiSlackFill,
} from "@remixicon/react";
import type { ComponentType } from "react";
import { Chip } from "@/components/base/badges/chip";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

interface Capabilities {
  github: boolean;
  slack: boolean;
  memory: boolean;
  toolGateway: boolean;
}

interface ConfigResponse {
  auth?: { google?: boolean };
  sandbox?: { provider?: "cube" | "daytona" };
  capabilities?: Capabilities;
}

interface SecretRow {
  name: string;
  kind?: string;
}

/** One honest capability row: real configured/not-configured state from
 *  /api/config, never a decorative toggle. */
function CapabilityRow({
  icon: Icon,
  name,
  detail,
  enabled,
}: {
  icon: IconComponent;
  name: string;
  detail: string;
  enabled: boolean;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <Icon className="text-text-secondary size-5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="text-body-2-medium text-text-primary block">{name}</span>
        <span className="text-caption-1-regular text-text-tertiary block truncate">{detail}</span>
      </span>
      <Chip color={enabled ? "lime" : "gray"}>
        {enabled ? "Enabled" : "Not configured"}
      </Chip>
    </div>
  );
}

/**
 * Real capability + skills panel. Everything rendered here is derived from the
 * live backend (/api/config capabilities + /api/skills) - no placeholder
 * services, no toggles that control nothing. A backend outage renders the
 * shared unreachable affordance, distinct from honest empty states.
 */
export function PluginsPanel() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [secrets, setSecrets] = useState<SecretRow[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // /api/config = config-gated platform capabilities; /api/secrets =
        // the org's stored credentials (NAMES + kind only, values write-only).
        // Both are honest reads of live state - no hardcoded integration list.
        const [cfgRes, secRes] = await Promise.all([
          fetch("/api/config"),
          fetch("/api/secrets"),
        ]);
        if (!cfgRes.ok) throw new Error("bad status");
        const cfg = (await cfgRes.json()) as ConfigResponse;
        const sec = secRes.ok ? ((await secRes.json()) as { secrets?: SecretRow[] }) : { secrets: [] };
        if (cancelled) return;
        setConfig(cfg);
        setSecrets(sec.secrets ?? []);
      } catch {
        if (!cancelled) setUnreachable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (unreachable) return <BackendUnreachable />;

  const caps = config?.capabilities;
  return (
    <div className="border-border-button-default bg-background-primary-default shadow-sm rounded-2xl border px-5 py-4">
      <h2 className="text-body-2-medium text-text-secondary">Connections</h2>
      <div className="mt-1">
        <CapabilityRow
          icon={RiGithubFill}
          name="GitHub"
          detail="Org repos via the GitHub App, cloned into run sandboxes"
          enabled={caps?.github ?? false}
        />
        <CapabilityRow
          icon={RiSlackFill}
          name="Slack"
          detail="Mention-triggered runs and durable thread replies"
          enabled={caps?.slack ?? false}
        />
        <CapabilityRow
          icon={RiDatabase2Line}
          name="Team memory"
          detail="Org and personal memory pools (recall + capture)"
          enabled={caps?.memory ?? false}
        />
        <CapabilityRow
          icon={RiPlugLine}
          name={`${config?.sandbox?.provider === "cube" ? "Cube" : config?.sandbox?.provider === "daytona" ? "Daytona" : "Sandbox"} runtime`}
          detail="Deployment-wide sandbox provider; knowledge and memory tools enabled"
          enabled={caps?.toolGateway ?? false}
        />
        <CapabilityRow
          icon={RiGoogleFill}
          name="Google sign-in"
          detail="Social auth for the workspace"
          enabled={config?.auth?.google ?? false}
        />
      </div>

      <div className="border-border-button-default my-4 border-t" />

      {/* Credentials = the org's stored secrets from the DB (names + kind only,
          values are write-only). This makes the page reflect what agents can
          actually authenticate to; managing them lives on the Secrets page.
          Skills are NOT listed here - they have their own page. */}
      <div className="flex items-center justify-between">
        <h2 className="text-body-2-medium text-text-secondary">Credentials</h2>
        {secrets !== null && (
          <span className="text-text-tertiary text-caption-1-medium tabular-nums">
            {secrets.length} in this org
          </span>
        )}
      </div>
      <div className="mt-1">
        {secrets === null ? (
          <p className="text-caption-1-regular text-text-tertiary py-2">Loading credentials...</p>
        ) : secrets.length === 0 ? (
          <p className="text-caption-1-regular text-text-tertiary py-2">
            No credentials yet. Add secrets on the Secrets page; each becomes an env var or file
            available inside run sandboxes.
          </p>
        ) : (
          secrets.map((s) => (
            <div key={s.name} className="flex items-center gap-3 py-1.5">
              <RiKey2Line className="text-text-secondary size-4 shrink-0" aria-hidden />
              <span className="text-caption-1-medium text-text-primary flex-1 truncate font-mono">
                {s.name}
              </span>
              <Chip color="lime">
                {s.kind === "file" ? "file" : "env"}
              </Chip>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
