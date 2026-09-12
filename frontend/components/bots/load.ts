import { loadThreadView, type ThreadView } from "@/components/chat/load-thread-view";
import { backendFetch } from "@/lib/backend-fetch";
import type { ApiBot } from "./types";

/** null only when the surface is off for this org (404); other failures throw. */
export async function loadBots(): Promise<ApiBot[] | null> {
  const response = await backendFetch("/api/bots");
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`bots list failed: ${response.status}`);
  const data = (await response.json()) as { bots?: ApiBot[] };
  return Array.isArray(data.bots) ? data.bots : [];
}

/** null when the bot (or the surface) does not exist; other failures throw. */
export async function loadBot(id: string): Promise<ApiBot | null> {
  const response = await backendFetch(`/api/bots/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`bot load failed: ${response.status}`);
  const data = (await response.json()) as { bot?: ApiBot };
  return data.bot ?? null;
}

/**
 * The bot's home thread through the same windowed loader the session page
 * uses. A missing thread (the run was removed) reads as "no thread yet"; a
 * transient failure throws rather than pretending the bot is new.
 */
export async function loadHomeThread(bot: ApiBot): Promise<ThreadView | null> {
  if (!bot.homeThreadId) return null;
  const probe = await backendFetch(`/api/runs/${bot.homeThreadId}`);
  if (probe.status === 404) return null;
  if (!probe.ok) throw new Error(`home thread failed: ${probe.status}`);
  return loadThreadView(bot.homeThreadId, false);
}
