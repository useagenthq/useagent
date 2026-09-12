import { type ApiRun, toThread } from "@/components/chat/types";
import { backendFetch } from "@/lib/backend-fetch";
import type { ApiBot } from "./types";

/** null when the surface is off for this org (404) or unreachable. */
export async function loadBots(): Promise<ApiBot[] | null> {
  try {
    const response = await backendFetch("/api/bots");
    if (!response.ok) return null;
    const data = (await response.json()) as { bots?: ApiBot[] };
    return Array.isArray(data.bots) ? data.bots : [];
  } catch {
    return null;
  }
}

export async function loadBot(id: string): Promise<ApiBot | null> {
  try {
    const response = await backendFetch(`/api/bots/${id}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { bot?: ApiBot };
    return data.bot ?? null;
  } catch {
    return null;
  }
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
