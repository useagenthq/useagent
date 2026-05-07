"use client";

import { useEffect, useState } from "react";
import {
  RiCloudLine,
  RiDatabase2Line,
  RiFlashlightLine,
  RiBookMarkedLine,
  RiGithubFill,
  RiGoogleFill,
  RiPlugLine,
  RiSlackFill,
} from "@remixicon/react";
import type { ComponentType } from "react";
import * as StatusBadge from "@/components/ui/status-badge";
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
  capabilities?: Capabilities;
}

interface SkillRow {
  id: string;
  name: string;
  kind?: string;
  version?: number;
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
      <Icon className="text-text-sub-600 size-5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="text-label-sm text-text-strong-950 block">{name}</span>
        <span className="text-paragraph-xs text-text-soft-400 block truncate">{detail}</span>
      </span>
      <StatusBadge.Root status={enabled ? "completed" : "disabled"} variant="light">
        {enabled ? "Enabled" : "Not configured"}
      </StatusBadge.Root>
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
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfgRes, skillsRes] = await Promise.all([
          fetch("/api/config"),
          fetch("/api/skills"),
        ]);
        if (!cfgRes.ok || !skillsRes.ok) throw new Error("bad status");
        const cfg = (await cfgRes.json()) as ConfigResponse;
        const sk = (await skillsRes.json()) as { skills?: SkillRow[] };
        if (cancelled) return;
        setConfig(cfg);
        setSkills(sk.skills ?? []);
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
    <div className="border-stroke-soft-200 bg-bg-white-0 shadow-regular-sm rounded-2xl border px-5 py-4">
      <h2 className="text-label-sm text-text-sub-600">Connections</h2>
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
          name="Sandbox tool gateway"
          detail="Knowledge and memory tools callable from inside sandboxes"
          enabled={caps?.toolGateway ?? false}
        />
        <CapabilityRow
          icon={RiGoogleFill}
          name="Google sign-in"
          detail="Social auth for the workspace"
          enabled={config?.auth?.google ?? false}
        />
      </div>

      <div className="border-stroke-soft-200 my-4 border-t" />

      <h2 className="text-label-sm text-text-sub-600">Skills</h2>
      <div className="mt-1">
        {skills === null ? (
          <p className="text-paragraph-xs text-text-soft-400 py-2">Loading skills...</p>
        ) : skills.length === 0 ? (
          <p className="text-paragraph-xs text-text-soft-400 py-2">
            No skills yet. Create one on the Skills page; versioned skills are pinned to runs
            when loaded.
          </p>
        ) : (
          skills.map((s) => (
            <div key={s.id} className="flex items-center gap-3 py-2">
              {s.kind === "playbook" ? (
                <RiBookMarkedLine className="text-text-sub-600 size-5 shrink-0" aria-hidden />
              ) : (
                <RiFlashlightLine className="text-text-sub-600 size-5 shrink-0" aria-hidden />
              )}
              <span className="text-label-xs text-text-strong-950 flex-1 font-mono">{s.name}</span>
              {typeof s.version === "number" && (
                <span className="text-text-soft-400 shrink-0 font-mono text-label-xs tabular-nums">
                  v{s.version}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
