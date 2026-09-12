import { BOT_STATES, type BotState } from "@useagent/agent-client";

export interface BotStatusPresentation {
  readonly state: BotState;
  readonly label: "Idle" | "Working" | "Needs you";
  readonly dotTone: "neutral" | "info" | "away";
  readonly pulse: boolean;
}

const STATUS: Record<BotState, BotStatusPresentation> = {
  idle: { state: "idle", label: "Idle", dotTone: "neutral", pulse: false },
  working: { state: "working", label: "Working", dotTone: "info", pulse: true },
  attention: { state: "attention", label: "Needs you", dotTone: "away", pulse: false },
};

/** One presentation for the bot state derived by GET /api/bots. */
export function botStatus(value: unknown): BotStatusPresentation {
  const state = (BOT_STATES as readonly unknown[]).includes(value) ? (value as BotState) : "idle";
  return STATUS[state];
}
