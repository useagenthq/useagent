/**
 * Slack targets for automation `notifications` / `delivery` configs. An
 * automation may declare where its firings and results go:
 *
 *   notifications: { slack: { channel: "C012ABC" } }  - posted when it FIRES
 *   delivery:      { slack: { channel: "C012ABC" } }  - posted when the fired
 *                                                       run reaches terminal
 *
 * This module is the ONE parser/validator for that shape (used by the enable
 * gate, the fire path, and run finalization) plus the message composers. It is
 * deliberately PURE (env + types only) so schedules/service.ts stays importable
 * by the standalone tool gateway. The durable enqueue itself stays on the
 * existing slack outbox surface (src/slack/outbox).
 */
import { slackConfig, type SlackConfig } from "../env";
import type { AutomationJson, RunStatus } from "../db/schema";
import { composeSlackReplyText } from "./reply";

export interface SlackAutomationTarget {
  readonly channel: string;
}

/** Parse an automation config's Slack target: `{ slack: { channel } }`. Returns
 *  null when the config carries no `slack` key at all; throws nothing — an
 *  unparseable `slack` value also returns null (callers treat it as not ready). */
export function parseSlackAutomationTarget(
  config: AutomationJson | null | undefined,
): SlackAutomationTarget | null {
  const slack = config?.slack;
  if (!slack || typeof slack !== "object" || Array.isArray(slack)) return null;
  const channel = (slack as Record<string, unknown>).channel;
  if (typeof channel !== "string") return null;
  const trimmed = channel.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  return { channel: trimmed };
}

/** True when server-initiated posts may target `channel` under the config's
 *  SLACK_CHANNEL_ALLOWLIST (null allowlist = unrestricted). */
export function slackChannelAllowed(channel: string, config: SlackConfig): boolean {
  return config.channelAllowlist.size === 0 || config.channelAllowlist.has(channel);
}

/**
 * Why an automation's notifications/delivery configs cannot execute right now,
 * or null when every present config is executable. Used by the enable gate:
 * drafts may carry anything, but ENABLING requires each present config to be a
 * recognized, currently-deliverable Slack target.
 */
export function automationSlackConfigError(automation: {
  readonly delivery: AutomationJson | null;
  readonly notifications: AutomationJson | null;
}): string | null {
  const configs = [
    ["delivery", automation.delivery],
    ["notifications", automation.notifications],
  ] as const;
  const config = slackConfig();
  for (const [name, value] of configs) {
    if (!value) continue;
    const target = parseSlackAutomationTarget(value);
    if (!target) {
      return `${name} must be a Slack target ({ slack: { channel } }) to enable`;
    }
    if (!config?.legacyBotToken) {
      return `${name} targets Slack, but the Slack integration is not configured`;
    }
    if (!slackChannelAllowed(target.channel, config)) {
      return `${name} channel ${target.channel} is not in SLACK_CHANNEL_ALLOWLIST`;
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
