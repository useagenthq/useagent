/** Path prefix of the same-origin bridge to a port served inside a thread's
 *  sandbox. Shared by the route and by the turn prompt that tells the agent
 *  which URL to print, so the two can never drift apart. */
export const PORT_PROXY_PATH = "/api/port-proxy";

/** The product URL at which a port served inside the thread's sandbox opens. */
export function portProxyUrl(origin: string, threadId: string, port: number | string): string {
  return `${origin.replace(/\/+$/, "")}${PORT_PROXY_PATH}/${threadId}/${port}/`;
}
