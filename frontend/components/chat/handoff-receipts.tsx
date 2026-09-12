"use client";

// What happened to a bot handoff. POST /api/runs answers with `handoffs[]`, one
// entry per @mentioned bot (backend/src/bots/handoffs.ts HandoffResult); the
// receipt row under the user's message says it in plain words. After a reload
// the durable relationship view carries the two outcomes that persist (a thread
// was opened for this run, or this run's mention became a later turn of it).

import { RiExternalLinkLine, RiRobot2Line } from "@remixicon/react";
import type { ProductThreadStatus, ThreadRelationship } from "@useagent/agent-client";
import Link from "next/link";
import { AvatarMark } from "@/components/bots/avatar-mark";
import { cx as cn } from "@/utils/cx";

export const HANDOFF_STATUSES = [
  "created",
  "replayed",
  "followed_up",
  "refused",
  "busy",
  "conflict",
  "not_found",
  "unavailable",
  "failed",
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];
export type HandoffRefusal = "self" | "cycle" | "depth" | "cap";

export interface HandoffReceipt {
  readonly botId: string;
  readonly name: string;
  readonly avatarTone?: string;
  readonly avatarIcon?: string;
  readonly threadId: string | null;
  readonly status: HandoffStatus;
  readonly childStatus?: ProductThreadStatus;
  readonly finalReply?: string | null;
  readonly reason?: HandoffRefusal;
  readonly retryAfterMs?: number;
  readonly error?: string;
}

const REFUSALS: ReadonlySet<string> = new Set(["self", "cycle", "depth", "cap"]);

function decodeReceipt(value: unknown): HandoffReceipt | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.botId !== "string" || typeof raw.status !== "string") return null;
  if (!(HANDOFF_STATUSES as readonly string[]).includes(raw.status)) return null;
  return {
    botId: raw.botId,
    name: typeof raw.name === "string" ? raw.name : "",
    ...(typeof raw.avatarTone === "string" ? { avatarTone: raw.avatarTone } : {}),
    ...(typeof raw.avatarIcon === "string" ? { avatarIcon: raw.avatarIcon } : {}),
    threadId: typeof raw.threadId === "string" ? raw.threadId : null,
    status: raw.status as HandoffStatus,
    ...(typeof raw.reason === "string" && REFUSALS.has(raw.reason)
      ? { reason: raw.reason as HandoffRefusal }
      : {}),
    ...(typeof raw.retryAfterMs === "number" && raw.retryAfterMs > 0
      ? { retryAfterMs: raw.retryAfterMs }
      : {}),
    ...(typeof raw.error === "string" && raw.error ? { error: raw.error } : {}),
  };
}

/** The accepted-run response `{ id, handoffs? }`; anything else decodes to nothing. */
export function decodeRunAccepted(body: unknown): {
  runId: string | null;
  handoffs: HandoffReceipt[];
} {
  const raw = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const handoffs = Array.isArray(raw.handoffs)
    ? raw.handoffs.map(decodeReceipt).filter((item): item is HandoffReceipt => item !== null)
    : [];
  return { runId: typeof raw.id === "string" ? raw.id : null, handoffs };
}

/** Receipts a reload can still show, keyed by the parent run they belong under:
 *  the run that opened a bot's thread, and every run whose mention became a
 *  later turn of it. Children the agent opened itself carry no bot and no row. */
export function deriveHandoffReceipts(
  children: readonly ThreadRelationship[],
): Map<string, HandoffReceipt[]> {
  const byRun = new Map<string, HandoffReceipt[]>();
  const push = (runId: string, receipt: HandoffReceipt) => {
    const list = byRun.get(runId) ?? [];
    list.push(receipt);
    byRun.set(runId, list);
  };
  for (const child of children) {
    if (!child.bot) continue;
    const base = {
      botId: child.bot.id,
      name: child.bot.name,
      ...(child.bot.avatarTone ? { avatarTone: child.bot.avatarTone } : {}),
      ...(child.bot.avatarIcon ? { avatarIcon: child.bot.avatarIcon } : {}),
      threadId: child.threadId,
    };
    const outcomes = child.handoffOutcomes ?? [];
    if (outcomes.length === 0) {
      push(child.sourceRunId, { ...base, status: "created" });
      for (const runId of child.followUpRunIds) push(runId, { ...base, status: "followed_up" });
      continue;
    }
    for (const outcome of outcomes) {
      push(outcome.sourceRunId, {
        ...base,
        status: outcome.sourceRunId === child.sourceRunId ? "created" : "followed_up",
        childStatus: outcome.status,
        finalReply: outcome.status === "completed" ? outcome.summary : null,
      });
    }
  }
  return byRun;
}

const SUCCESS: ReadonlySet<HandoffStatus> = new Set(["created", "replayed", "followed_up"]);

export function isHandoffSuccess(receipt: HandoffReceipt): boolean {
  return SUCCESS.has(receipt.status);
}

/** Live accepted receipts remain until their exact durable bot turn appears;
 *  durable state then advances that bot without hiding unrelated failures. */
export function mergeHandoffReceipts(
  optimistic: readonly HandoffReceipt[] | undefined,
  durable: readonly HandoffReceipt[] | undefined,
): HandoffReceipt[] | undefined {
  if (!optimistic?.length) return durable ? [...durable] : undefined;
  if (!durable?.length) return [...optimistic];
  const durableByBot = new Map(durable.map((receipt) => [receipt.botId, receipt]));
  const merged = optimistic.map((receipt) => {
    const persisted = durableByBot.get(receipt.botId);
    if (!persisted) return receipt;
    durableByBot.delete(receipt.botId);
    return isHandoffSuccess(receipt) ? persisted : receipt;
  });
  return [...merged, ...durableByBot.values()];
}

function retryHint(ms: number | undefined): string {
  if (!ms) return "Try again in a moment.";
  const minutes = Math.ceil(ms / 60_000);
  return minutes <= 1 ? "Try again in a minute." : `Try again in ${minutes} minutes.`;
}

/** One plain sentence for a receipt. The name falls back for `not_found`, where
 *  the backend has no bot to name. */
export function handoffReceiptText(receipt: HandoffReceipt): string {
  const name = receipt.name || "That bot";
  switch (receipt.status) {
    case "created":
      return `Handed to ${name}.`;
    case "replayed":
      return `Already handed to ${name}.`;
    case "followed_up":
      return `Sent to ${name}'s existing thread.`;
    case "refused":
      switch (receipt.reason) {
        case "self":
          return `${name} can't hand work to itself.`;
        case "cycle":
          return `${name} is already working above this thread, so it can't take this.`;
        case "depth":
          return `This thread is already as deep as handoffs go, so ${name} didn't get this.`;
        case "cap":
          return `${name} has taken on as much as it can for now. ${retryHint(receipt.retryAfterMs)}`;
        default:
          return `${name} didn't take this.`;
      }
    case "busy":
      return `${name}'s thread is busy right now. Try again in a moment.`;
    case "conflict":
      return `This handoff clashed with an earlier one, so ${name} didn't get it. Send the message again.`;
    case "not_found":
      return "That bot no longer exists, so nothing was handed off.";
    case "unavailable":
      return `Bot threads are turned off here, so ${name} didn't get this.`;
    case "failed":
      return receipt.error
        ? `${name} didn't get this: ${receipt.error}`
        : `${name} didn't get this. Try again.`;
  }
}

/** Durable child state replaces the admission sentence only after the handoff settles. */
export function handoffReceiptPreview(receipt: HandoffReceipt): string {
  const name = receipt.name || "That bot";
  if (receipt.childStatus === "completed") {
    const reply = receipt.finalReply?.trim();
    return reply ? `${name}: ${reply}` : `${name} finished with no reply.`;
  }
  if (receipt.childStatus === "failed") return `${name}'s handoff failed.`;
  if (receipt.childStatus === "cancelled") return `${name}'s handoff was cancelled.`;
  return handoffReceiptText(receipt);
}

/** The composer notice for a batch of receipts: every outcome that means a bot
 *  did NOT get the message, or null when all of them did. */
export function handoffNotice(receipts: readonly HandoffReceipt[]): string | null {
  const missed = receipts.filter((receipt) => !isHandoffSuccess(receipt));
  return missed.length > 0 ? missed.map(handoffReceiptText).join(" ") : null;
}

const TONE: Record<HandoffStatus, string> = {
  created: "text-text-secondary",
  replayed: "text-text-secondary",
  followed_up: "text-text-secondary",
  busy: "text-warning-base",
  unavailable: "text-warning-base",
  refused: "text-text-error-primary",
  conflict: "text-text-error-primary",
  not_found: "text-text-error-primary",
  failed: "text-text-error-primary",
};

function receiptTone(receipt: HandoffReceipt): string {
  return receipt.childStatus === "failed" || receipt.childStatus === "cancelled"
    ? "text-text-error-primary"
    : TONE[receipt.status];
}

/** One row per bot under the user's message, right-aligned with the bubble. */
export function HandoffReceipts({ receipts }: { receipts?: readonly HandoffReceipt[] }) {
  if (!receipts || receipts.length === 0) return null;
  return (
    <ul className="flex flex-col items-end gap-1" data-testid="handoff-receipts">
      {receipts.map((receipt) => (
        <li
          key={`${receipt.botId}:${receipt.status}`}
          data-handoff-status={receipt.status}
          data-child-status={receipt.childStatus}
          className={cn("flex max-w-[85%] items-center gap-1.5 text-caption-1-regular", receiptTone(receipt))}
        >
          {receipt.avatarTone ? (
            <AvatarMark
              tone={receipt.avatarTone}
              icon={receipt.avatarIcon}
              size="size-4"
              className="shrink-0"
            />
          ) : (
            <RiRobot2Line className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 truncate" title={receipt.finalReply?.trim() || undefined}>
            {handoffReceiptPreview(receipt)}
          </span>
          {receipt.threadId && isHandoffSuccess(receipt) ? (
            <Link
              href={`/session/${receipt.threadId}`}
              className="flex shrink-0 items-center gap-0.5 rounded text-caption-1-medium text-text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              Open thread
              <RiExternalLinkLine className="size-3" aria-hidden />
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
