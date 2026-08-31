/**
 * Slack targets for automation `notifications` / `delivery` configs. An
 * automation may declare where its firings and results go:
 *
 *   notifications: { slack: { teamId: "T012", channel: "C012ABC" } }
 *   delivery:      { slack: { teamId: "T012", channel: "C012ABC" } }
 *
 * This module is the ONE parser/validator for that shape (used by the enable
 * gate, the fire path, and run finalization) plus the message composers. It is
 * The durable enqueue itself stays on the existing Slack outbox surface. Every
 * executable target is tenant-qualified by workspace before it reaches that
 * outbox; channel allowlisting alone is not authorization.
 */
import { slackConfig, type SlackConfig } from "../env";
import type { AutomationJson, RunStatus } from "../db/schema";
import { db, type Executor } from "../db/client";
import { composeSlackReplyText } from "./reply";
import { findSlackWorkspace } from "./workspaces";
import { resolveSlackBotTokenForWorkspace } from "../integrations/slack-token-resolver";

export interface SlackAutomationTarget {
  readonly teamId: string;
  readonly channel: string;
}

/** Parse an automation config's tenant-qualified Slack target. Returns
 *  null when the config carries no `slack` key at all; throws nothing — an
 *  unparseable `slack` value also returns null (callers treat it as not ready). */
export function parseSlackAutomationTarget(
  config: AutomationJson | null | undefined,
): SlackAutomationTarget | null {
  const slack = config?.slack;
  if (!slack || typeof slack !== "object" || Array.isArray(slack)) return null;
  const target = slack as Record<string, unknown>;
  const teamId = target.teamId;
  const channel = target.channel;
  if (typeof teamId !== "string" || typeof channel !== "string") return null;
  const trimmedTeamId = teamId.trim();
  const trimmed = channel.trim();
  if (!trimmedTeamId || /\s/.test(trimmedTeamId) || !trimmed || /\s/.test(trimmed)) return null;
  return { teamId: trimmedTeamId, channel: trimmed };
}

/** True when server-initiated posts may target `channel` under the config's
 *  SLACK_CHANNEL_ALLOWLIST (null allowlist = unrestricted). */
export function slackChannelAllowed(channel: string, config: SlackConfig): boolean {
  return config.channelAllowlist.size === 0 || config.channelAllowlist.has(channel);
}

function configuredSlackAutomationTarget(
  value: AutomationJson | null | undefined,
  config: SlackConfig,
): SlackAutomationTarget | null {
  const target = parseSlackAutomationTarget(value);
  if (target) return target;
  const slack = value?.slack;
  if (!slack || typeof slack !== "object" || Array.isArray(slack)) return null;
  const channel = (slack as Record<string, unknown>).channel;
  if (
    typeof channel !== "string" ||
    !channel.trim() ||
    /\s/.test(channel.trim()) ||
    !config.legacyTeamId ||
    !config.legacyBotToken
  ) {
    return null;
  }
  return { teamId: config.legacyTeamId, channel: channel.trim() };
}

/**
 * Why an automation's notifications/delivery configs cannot execute right now,
 * or null when every present config is executable. Used by the enable gate:
 * drafts may carry anything, but ENABLING requires each present config to be a
 * recognized, currently-deliverable Slack target.
 */
export async function resolveSlackAutomationTargetForOrg(
  value: AutomationJson | null | undefined,
  orgId: string,
  exec: Executor = db,
): Promise<SlackAutomationTarget | null> {
  const config = slackConfig();
  if (!config) return null;
  const target = configuredSlackAutomationTarget(value, config);
  if (!target || !slackChannelAllowed(target.channel, config)) return null;
  const workspace = await findSlackWorkspace(target.teamId, exec);
  if (workspace?.orgId !== orgId) return null;
  const botToken = await resolveSlackBotTokenForWorkspace({ orgId, teamId: target.teamId, config });
  return botToken ? target : null;
}

export async function automationSlackConfigError(automation: {
  readonly delivery: AutomationJson | null;
  readonly notifications: AutomationJson | null;
}, orgId: string, exec: Executor = db): Promise<string | null> {
  const configs = [
    ["delivery", automation.delivery],
    ["notifications", automation.notifications],
  ] as const;
  const config = slackConfig();
  for (const [name, value] of configs) {
    if (!value) continue;
    if (!config) {
      return `${name} targets Slack, but the Slack integration is not configured`;
    }
    const target = configuredSlackAutomationTarget(value, config);
    if (!target) {
      return `${name} must be a Slack target ({ slack: { teamId, channel } }) to enable`;
    }
    if (!slackChannelAllowed(target.channel, config)) {
      return `${name} channel ${target.channel} is not in SLACK_CHANNEL_ALLOWLIST`;
    }
    const workspace = await findSlackWorkspace(target.teamId, exec);
    if (workspace?.orgId !== orgId) {
      return `${name} Slack workspace ${target.teamId} is not connected to this organization`;
    }
    if (!await resolveSlackBotTokenForWorkspace({ orgId, teamId: target.teamId, config })) {
      return `${name} Slack workspace ${target.teamId} has no executable bot credential`;
    }
  }
  return null;
}

/** The fire-time notification message ("this automation just fired"). */
export function composeAutomationFireText(name: string, runId: string): string {
  return `Automation "${name}" fired run ${runId}.`;
}

/** The delivery message: the fired run's terminal outcome (same composition as
 *  the Slack thread reply), prefixed with the automation it came from. */
export function composeAutomationDeliveryText(
  name: string,
  status: RunStatus,
  summary: string | null,
): string {
  return `Automation "${name}" run finished.\n${composeSlackReplyText(status, summary)}`;
}
