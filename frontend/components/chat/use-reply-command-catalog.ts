"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type CanonicalCommandView,
  type CommandCatalogState,
  resolveCommandCatalog,
  selectSessionCommands,
} from "@/components/chat/canonical-timeline";
import type { SlashCommand } from "@/components/chat/slash-command";
import type { ThreadSnapshot } from "@/components/chat/thread-store";
import { type EngineId, normalizeEngine } from "@/components/chat/types";
import { backendFetch } from "@/lib/backend-fetch";

/**
 * Slash-command catalog for the reply composer's "/" autocomplete - the SELECTED engine's
 * real native commands, capability-driven (no provider-name gate). Authoritative source is
 * the DURABLE canonical stream's per-session `commands.updated`, SESSION-SCOPED to the current
 * native session so a historical or other-session snapshot can NEVER mask the active session
 * (a restarted/new session that has not re-advertised falls back to the pre-session priming
 * fetch rather than showing stale commands). The live session snapshot always wins; the priming
 * fetch (GET /api/commands, keyed by engine - one path for OpenCode/Claude/Codex, no per-engine
 * side channel) only primes until this session advertises. `resolveCommandCatalog` folds both
 * into one honest state (loading / unavailable / error / ready[+stale]).
 *
 * Both results are memoized so the memoized Conversation sees stable prop identities between
 * catalog changes (a re-render here must not re-render the whole timeline).
 */
export function useReplyCommandCatalog(
  runsById: ThreadSnapshot["byId"],
  engineSessionId: string | null,
  rawEngine: EngineId,
): { catalogState: CommandCatalogState; commands: SlashCommand[] } {
  const engine = normalizeEngine(rawEngine);
  const durableCommands = useMemo(
    () => selectSessionCommands([...runsById.values()], engineSessionId),
    [runsById, engineSessionId],
  );
  const hasDurable = durableCommands !== null;
  const [fetchState, setFetchState] = useState<{
    phase: "loading" | "done" | "error";
    commands: CanonicalCommandView[];
  }>({
    phase: "loading",
    commands: [],
  });
  useEffect(() => {
    if (hasDurable) return; // the durable session catalog wins; no priming fetch needed
    let cancelled = false;
    // Clear-on-change: reset immediately so a prior engine's commands never linger while loading.
    setFetchState({ phase: "loading", commands: [] });
    void (async () => {
      const fail = () => !cancelled && setFetchState({ phase: "error", commands: [] });
      try {
        // ONE pre-session priming path for every engine: the org/snapshot catalog via GET
        // /api/commands (keyed by engine). The durable per-session `commands.updated` (now emitted
        // by opencode too, C5) is authoritative and supersedes this the moment the session advertises.
        const res = await backendFetch(`/api/commands?engine=${encodeURIComponent(engine)}`);
        if (!res.ok) return fail();
        const list =
          (
            (await res.json()) as {
              commands?: { name?: string; description?: string; input?: string }[];
            }
          ).commands ?? [];
        if (cancelled) return;
        if (!Array.isArray(list)) return fail();
        setFetchState({
          phase: "done",
          commands: list
            .filter((c): c is { name: string; description?: string; input?: string } => !!c.name)
            .map((c) => ({
              name: c.name,
              description: c.description ?? null,
              input: typeof c.input === "string" ? c.input : null,
            })),
        });
      } catch {
        fail();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, hasDurable]);
  const catalogState = useMemo(
    () => resolveCommandCatalog(durableCommands, fetchState, engine),
    [durableCommands, fetchState, engine],
  );
  const commands: SlashCommand[] = useMemo(
    () =>
      catalogState.status === "ready"
        ? catalogState.commands.map((c) => ({ name: c.name, description: c.description ?? null }))
        : [],
    [catalogState],
  );
  return { catalogState, commands };
}
