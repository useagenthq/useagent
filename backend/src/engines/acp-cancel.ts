import { sandboxPreviewHeaders } from "../sandboxes/provider";
import { buildSessionCancel } from "./acp-rpc";

/** Best-effort native ACP cancel with its own short timeout. */
export async function sendSessionCancel(
  baseUrl: string,
  token: string,
  sessionId: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const ac = new AbortController();
  const budget = setTimeout(() => ac.abort(), 5_000);
  try {
    const response = await fetcher(`${baseUrl}/send`, {
      method: "POST",
      headers: { ...sandboxPreviewHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(buildSessionCancel(sessionId)),
      signal: ac.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(budget);
  }
}
