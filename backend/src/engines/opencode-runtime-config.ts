export interface OpenCodeRuntimeServer {
  readonly baseUrl: string;
  readonly token: string;
  readonly workdir: string;
}

type JsonObject = Record<string, unknown>;
type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface RuntimeConfigInput {
  readonly server: OpenCodeRuntimeServer;
  readonly config: JsonObject;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
  readonly fetcher?: Fetcher;
  readonly timeoutMs?: number;
}

const MANAGED_MCP_PREFIX = "skynet-";
const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function containsExpected(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => containsExpected(actual[index], item));
  }
  const expectedObject = asObject(expected);
  if (!expectedObject) return Object.is(actual, expected);
  const actualObject = asObject(actual);
  return actualObject !== null && Object.entries(expectedObject).every(
    ([key, value]) => containsExpected(actualObject[key], value),
  );
}

function managedProviders(config: JsonObject): JsonObject {
  const providers = asObject(config.provider) ?? {};
  return Object.fromEntries(
    Object.entries(providers).filter(([, provider]) => {
      const options = asObject(asObject(provider)?.options);
      return typeof options?.apiKey === "string" && typeof options.baseURL === "string";
    }),
  );
}

function managedMcpServers(config: JsonObject): JsonObject {
  const mcp = asObject(config.mcp) ?? {};
  return Object.fromEntries(
    Object.entries(mcp).filter(
      ([name, value]) => name.startsWith(MANAGED_MCP_PREFIX) && value !== false,
    ),
  );
}

function authHeaders(server: OpenCodeRuntimeServer): Record<string, string> {
  return {
    "x-daytona-preview-token": server.token,
    "content-type": "application/json",
  };
}

function runtimeUrl(server: OpenCodeRuntimeServer, path: string): string {
  const url = new URL(path, `${server.baseUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("directory", server.workdir);
  return url.toString();
}

async function successful(
  fetcher: Fetcher,
  url: string,
  server: OpenCodeRuntimeServer,
  signal: AbortSignal,
): Promise<boolean> {
  const response = await fetcher(url, {
    headers: authHeaders(server),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  await response.body?.cancel().catch(() => {});
  return response.ok;
}

async function managedMcpConnected(
  fetcher: Fetcher,
  server: OpenCodeRuntimeServer,
  signal: AbortSignal,
  expectedMcp: JsonObject,
): Promise<boolean> {
  const response = await fetcher(runtimeUrl(server, "/mcp"), {
    headers: authHeaders(server),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return false;
  }
  const status = asObject(await response.json());
  return status !== null && Object.keys(expectedMcp).every(
    (name) => asObject(status[name])?.status === "connected",
  );
}

async function verifyOnce(input: Required<Pick<RuntimeConfigInput, "server" | "config" | "signal">> & {
  readonly sessionId?: string;
  readonly fetcher: Fetcher;
}): Promise<boolean> {
  const expectedProviders = managedProviders(input.config);
  const expectedMcp = managedMcpServers(input.config);
  const configResponse = await input.fetcher(runtimeUrl(input.server, "/config"), {
    headers: authHeaders(input.server),
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]),
  });
  if (!configResponse.ok) {
    await configResponse.body?.cancel().catch(() => {});
    return false;
  }
  const effective = asObject(await configResponse.json());
  if (
    !effective ||
    !containsExpected(managedProviders(effective), expectedProviders) ||
    !containsExpected(managedMcpServers(effective), expectedMcp)
  ) {
    return false;
  }

  const providerReady = Object.keys(expectedProviders).length === 0
    ? Promise.resolve(true)
    : successful(
        input.fetcher,
        runtimeUrl(input.server, "/provider"),
        input.server,
        input.signal,
      );
  const sessionReady = input.sessionId
    ? successful(
        input.fetcher,
        runtimeUrl(input.server, `/session/${encodeURIComponent(input.sessionId)}`),
        input.server,
        input.signal,
      )
    : Promise.resolve(true);
  const mcpReady = Object.keys(expectedMcp).length === 0
    ? Promise.resolve(true)
    : managedMcpConnected(input.fetcher, input.server, input.signal, expectedMcp);

  const readiness = await Promise.all([providerReady, sessionReady, mcpReady]);
  return readiness.every(Boolean);
}

/** Prove the resident process sees the exact managed provider/MCP config before
 * dispatching a prompt. OpenCode 1.17.x disposes instances asynchronously after
 * a global config update, so a successful PATCH alone is not an activation gate. */
export async function verifyOpenCodeRuntimeConfig(input: RuntimeConfigInput): Promise<void> {
  const fetcher = input.fetcher ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  do {
    if (input.signal.aborted) throw new Error("OpenCode runtime config activation aborted");
    try {
      if (await verifyOnce({ ...input, fetcher })) return;
    } catch {
      // The instance is disposed asynchronously. Transient connection failures
      // are expected until the replacement instance is ready.
    }
    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } while (Date.now() < deadline);
  throw new Error("OpenCode runtime config did not become active");
}

/** Update global config in-process, then wait for provider/MCP/session state to
 * be rebuilt from that exact payload. Errors contain status only—never config. */
export async function activateOpenCodeRuntimeConfig(input: RuntimeConfigInput): Promise<void> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(
    new URL("/global/config", `${input.server.baseUrl.replace(/\/+$/, "")}/`),
    {
      method: "PATCH",
      headers: authHeaders(input.server),
      body: JSON.stringify(input.config),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]),
    },
  );
  await response.body?.cancel().catch(() => {});
  if (!response.ok) {
    throw new Error(`OpenCode global config update failed (HTTP ${response.status})`);
  }
  await verifyOpenCodeRuntimeConfig({ ...input, fetcher });
}
