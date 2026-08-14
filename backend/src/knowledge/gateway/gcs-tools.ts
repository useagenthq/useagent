import { sign } from "node:crypto";
import { decryptOrgSecretByName, type DecryptedSecret } from "../../secrets/store";
import type { ToolTokenClaims } from "./token";

const GCP_CREDENTIAL_NAMES = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GCP_SERVICE_ACCOUNT_KEY",
] as const;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_STORAGE_URL = "https://storage.googleapis.com/storage/v1/b";
const STORAGE_READ_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 1_000;
const REQUEST_TIMEOUT_MS = Number(process.env.GCS_GATEWAY_TIMEOUT_MS) || 30_000;
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

interface ServiceAccount {
  readonly client_email: string;
  readonly private_key: string;
  readonly project_id: string;
  readonly token_uri?: string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GcsToolDeps {
  readonly decryptSecret?: typeof decryptOrgSecretByName;
  readonly fetchGoogle?: FetchLike;
  readonly now?: () => number;
}

const result = (text: string, structuredContent?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
});

const failure = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export const GCS_TOOLS = [
  {
    name: "gcs_list_buckets",
    description:
      "List Google Cloud Storage bucket names for this workspace through the trusted " +
      "tenant gateway. The service-account credential remains in the control plane and " +
      "is never exposed to the sandbox. This tool is read-only.",
    inputSchema: {
      type: "object",
      properties: {
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RESULTS,
          description: `Maximum bucket names to return (default ${DEFAULT_MAX_RESULTS}).`,
        },
      },
      additionalProperties: false,
    },
  },
] as const;

export const GCS_TOOL_NAMES: ReadonlySet<string> = new Set(
  GCS_TOOLS.map((tool) => tool.name),
);

function parseServiceAccount(value: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("workspace GCP credential is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("workspace GCP credential is malformed");
  }
  const candidate = parsed as Partial<ServiceAccount>;
  if (
    typeof candidate.client_email !== "string" ||
    !candidate.client_email.includes("@") ||
    typeof candidate.private_key !== "string" ||
    !candidate.private_key.includes("BEGIN PRIVATE KEY") ||
    typeof candidate.project_id !== "string" ||
    !PROJECT_ID_RE.test(candidate.project_id)
  ) {
    throw new Error("workspace GCP service-account fields are malformed");
  }
  if (candidate.token_uri && candidate.token_uri !== GOOGLE_TOKEN_URL) {
    throw new Error("workspace GCP token endpoint is not allowed");
  }
  return {
    client_email: candidate.client_email,
    private_key: candidate.private_key,
    project_id: candidate.project_id,
    token_uri: GOOGLE_TOKEN_URL,
  };
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createServiceAccountAssertion(
  account: ServiceAccount,
  nowMs: number,
): string {
  const issuedAt = Math.floor(nowMs / 1_000);
  const unsigned = [
    base64UrlJson({ alg: "RS256", typ: "JWT" }),
    base64UrlJson({
      iss: account.client_email,
      scope: STORAGE_READ_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    }),
  ].join(".");
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), account.private_key)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

async function findCredential(
  orgId: string,
  decryptSecret: typeof decryptOrgSecretByName,
): Promise<DecryptedSecret | null> {
  for (const name of GCP_CREDENTIAL_NAMES) {
    const credential = await decryptSecret(orgId, name);
    if (credential) return credential;
  }
  return null;
}

async function exchangeAccessToken(
  account: ServiceAccount,
  fetchGoogle: FetchLike,
  nowMs: number,
): Promise<string> {
  const response = await fetchGoogle(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: createServiceAccountAssertion(account, nowMs),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Google OAuth rejected the credential (${response.status})`);
  const payload = await response.json().catch(() => null) as {
    access_token?: unknown;
    token_type?: unknown;
  } | null;
  if (
    typeof payload?.access_token !== "string" ||
    (payload.token_type !== undefined && payload.token_type !== "Bearer")
  ) {
    throw new Error("Google OAuth returned an invalid access token response");
  }
  return payload.access_token;
}

async function listBuckets(
  account: ServiceAccount,
  accessToken: string,
  maxResults: number,
  fetchGoogle: FetchLike,
): Promise<string[]> {
  const buckets: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(GOOGLE_STORAGE_URL);
    url.searchParams.set("project", account.project_id);
    url.searchParams.set("maxResults", String(Math.min(1_000, maxResults - buckets.length)));
    url.searchParams.set("fields", "items/name,nextPageToken");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchGoogle(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Google Cloud Storage rejected bucket listing (${response.status})`);
    }
    const payload = await response.json().catch(() => null) as {
      items?: unknown;
      nextPageToken?: unknown;
    } | null;
    if (!payload) throw new Error("Google Cloud Storage returned invalid JSON");
    for (const raw of Array.isArray(payload.items) ? payload.items : []) {
      const name = (raw as { name?: unknown }).name;
      if (typeof name === "string" && name && buckets.length < maxResults) buckets.push(name);
    }
    pageToken = typeof payload.nextPageToken === "string" && buckets.length < maxResults
      ? payload.nextPageToken
      : undefined;
  } while (pageToken);
  return buckets;
}

export async function executeGcsTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
  deps: GcsToolDeps = {},
): Promise<ToolResult> {
  if (name !== "gcs_list_buckets") return failure(`Unknown tool: ${name}`);
  const requested = Number(args.max_results ?? DEFAULT_MAX_RESULTS);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_RESULTS) {
    return failure(`gcs_list_buckets max_results must be an integer from 1 to ${MAX_RESULTS}.`);
  }

  try {
    const credential = await findCredential(
      claims.orgId,
      deps.decryptSecret ?? decryptOrgSecretByName,
    );
    if (!credential) return failure("Google Cloud Storage is not configured for this workspace.");
    const account = parseServiceAccount(credential.value);
    const fetchGoogle = deps.fetchGoogle ?? fetch;
    const accessToken = await exchangeAccessToken(
      account,
      fetchGoogle,
      (deps.now ?? Date.now)(),
    );
    const buckets = await listBuckets(account, accessToken, requested, fetchGoogle);
    return result(
      `GCS buckets for project ${account.project_id} (${buckets.length}):\n` +
        (buckets.length > 0 ? buckets.join("\n") : "NONE"),
      { projectId: account.project_id, buckets, count: buckets.length },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "GCS gateway failed";
    return failure(`Could not list GCS buckets: ${message}`);
  }
}
