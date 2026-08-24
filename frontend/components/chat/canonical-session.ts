import type {
  CommandCatalogEntry,
  SessionCommandCatalog,
} from "@useagent/agent-client/wire";
import type { StoredCanonicalEvent } from "./canonical-timeline";

/** A native slash command as surfaced to the composer's "/" popover - the shared
 *  wire `CommandCatalogEntry`. */
export type CanonicalCommandView = CommandCatalogEntry;

// The session command catalog is the agent-client wire contract (shared with the
// backend authorizer); re-exported so this module's consumers keep one path.
export type { SessionCommandCatalog };

export function selectSessionCommandCatalog(
  runs: readonly { readonly canonical: readonly StoredCanonicalEvent[] }[],
  sessionId: string | null,
): SessionCommandCatalog | null {
  if (!sessionId) return null;
  let latest: StoredCanonicalEvent | null = null;
  for (const run of runs) {
    for (const event of run.canonical) {
      if (
        event.kind === "commands.updated" &&
        event.identity?.nativeSessionId === sessionId &&
        (latest === null || event.deliverySeq > latest.deliverySeq)
      ) {
        latest = event;
      }
    }
  }
  if (!latest) return null;
  return {
    commands: [...(latest.catalog ?? [])].map((command) => ({
      name: command.name,
      description: command.description ?? null,
      input: command.input ?? null,
    })),
    revision: latest.deliverySeq,
  };
}

export function selectSessionCommands(
  runs: readonly { readonly canonical: readonly StoredCanonicalEvent[] }[],
  sessionId: string | null,
): readonly CanonicalCommandView[] | null {
  return selectSessionCommandCatalog(runs, sessionId)?.commands ?? null;
}

export function selectSessionCapabilities(
  runs: readonly { readonly canonical: readonly StoredCanonicalEvent[] }[],
  sessionId: string | null,
): Readonly<Record<string, boolean>> | null {
  if (!sessionId) return null;
  let latest: StoredCanonicalEvent | null = null;
  for (const run of runs) {
    for (const event of run.canonical) {
      if (
        event.kind === "session.started" &&
        event.identity?.nativeSessionId === sessionId &&
        (latest === null || event.deliverySeq > latest.deliverySeq)
      ) {
        latest = event;
      }
    }
  }
  return latest?.capabilities ?? null;
}

export function selectActiveSessionId(
  runs: readonly { readonly canonical: readonly StoredCanonicalEvent[] }[],
  newestRunId: string | null,
): string | null {
  if (!newestRunId) return null;
  let latest: StoredCanonicalEvent | null = null;
  for (const run of runs) {
    for (const event of run.canonical) {
      if (
        event.kind === "session.started" &&
        event.runId === newestRunId &&
        event.identity?.nativeSessionId &&
        (latest === null || event.deliverySeq > latest.deliverySeq)
      ) {
        latest = event;
      }
    }
  }
  return latest?.identity?.nativeSessionId ?? null;
}

export type CommandCatalogState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly source?: string }
  | { readonly status: "error" }
  | {
      readonly status: "ready";
      readonly commands: readonly CanonicalCommandView[];
      readonly source?: string;
      readonly stale?: boolean;
    };

export function resolveCommandCatalog(
  durable: readonly CanonicalCommandView[] | null,
  fetchState: { phase: "loading" | "done" | "error"; commands: readonly CanonicalCommandView[] },
  source?: string,
): CommandCatalogState {
  if (durable !== null) {
    return durable.length > 0
      ? { status: "ready", commands: durable, source }
      : { status: "unavailable", source };
  }
  if (fetchState.phase === "loading") return { status: "loading" };
  if (fetchState.phase === "error") return { status: "error" };
  return fetchState.commands.length > 0
    ? { status: "ready", commands: fetchState.commands, source, stale: true }
    : { status: "unavailable", source };
}
