import { type ApiRun, toThread } from "@/components/chat/types";
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

/** The bot's home thread, root first. [] when it has none or the load fails. */
export async function loadHomeThread(threadId: string): Promise<ApiRun[]> {
  try {
    const response = await backendFetch(`/api/runs/${threadId}?thread=1`);
    if (!response.ok) return [];
    return toThread(await response.json());
  } catch {
    return [];
  }
}
