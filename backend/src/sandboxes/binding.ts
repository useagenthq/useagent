import type { SandboxProvider, SandboxProviderKind } from "@useagent/sandbox-contract";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/client";
import { runs } from "../db/schema";
import { listProviderConnections } from "../provider-connections/repo";
import { getTrustedProviderCredential } from "../provider-connections/service";
import { resolveGatewayComputerApiKeyConnection } from "../provider-gateway/api-key-credentials";
import {
  sandboxProviderFor,
  sandboxProviderApiKey,
  sandboxProviderApiKeyFor,
  sandboxProviderKind,
  sandboxTemplate,
} from "./provider";
import { isSandboxProviderKind } from "./plugins";

/**
 * Which computer a run's sandbox lives on. The server's env provider is the
 * default; when USER_COMPUTERS is on, a user's connected Daytona or Box key
 * (Settings > Infrastructure) runs that user's work on their own account.
 * The choice is recorded on the run so every later touch of that sandbox
 * (preview, files, recording, release) talks to the provider that made it.
 */

export type SandboxCredentialSource = "env" | "user";
export const COMPUTER_PROVIDER_KINDS = ["daytona", "box"] as const;
export type ComputerProviderKind = (typeof COMPUTER_PROVIDER_KINDS)[number];

export class PersonalSandboxConnectionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonalSandboxConnectionUnavailableError";
  }
}

export interface SandboxBinding {
  readonly kind: SandboxProviderKind;
  readonly provider: SandboxProvider;
  /** User bindings carry the connection's snapshot (null = provider base image). */
  readonly snapshot: string | null;
  readonly credential: SandboxCredentialSource;
  readonly userId: string | null;
  /** Version of the user connection used to build this provider instance. */
  readonly connectionUpdatedAt?: string;
}

export interface SandboxBindingDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly connections?: typeof listProviderConnections;
  readonly credential?: typeof getTrustedProviderCredential;
  /** Restricted gateway resolver backed by the filtered API-key view. */
  readonly gatewayConnection?: typeof resolveGatewayComputerApiKeyConnection;
  /** Test seam: provider factories per kind (default: the plugin registry). */
  readonly providers?: Partial<Record<SandboxProviderKind, (apiKey: string) => SandboxProvider>>;
  readonly envProvider?: () => SandboxBinding | null;
}

export function userComputersEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = (env.USER_COMPUTERS ?? "").trim().toLowerCase();
  return value === "1" || value === "on" || value === "true";
}

function isComputerKind(value: unknown): value is ComputerProviderKind {
  return typeof value === "string" && (COMPUTER_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** The server's own provider from env; null when no credential is configured. */
export function envSandboxBinding(env: Readonly<Record<string, string | undefined>> = process.env): SandboxBinding | null {
  const kind = sandboxProviderKind(env);
  const apiKey = sandboxProviderApiKey(env);
  if (apiKey === undefined) return null;
  return { kind, provider: sandboxProviderFor(kind, apiKey, env), snapshot: null, credential: "env", userId: null };
}

function requireEnvBinding(deps: SandboxBindingDeps): SandboxBinding {
  const binding = (deps.envProvider ?? (() => envSandboxBinding(deps.env)))();
  if (!binding) throw new Error("sandbox provider credentials are unavailable");
  return binding;
}

function requireRecordedEnvBinding(kind: SandboxProviderKind, deps: SandboxBindingDeps): SandboxBinding {
  const env = deps.env ?? process.env;
  const apiKey = sandboxProviderApiKeyFor(kind, env);
  if (apiKey === undefined) {
    throw new Error(`sandbox provider credentials are unavailable for recorded ${kind} sandbox`);
  }
  const build = deps.providers?.[kind] ?? ((key: string) => sandboxProviderFor(kind, key, env));
  return { kind, provider: build(apiKey), snapshot: null, credential: "env", userId: null };
}

async function userSandboxBinding(
  scope: { readonly orgId: string; readonly userId: string },
  onlyKind: ComputerProviderKind | null,
  deps: SandboxBindingDeps,
): Promise<SandboxBinding | null> {
  const env = deps.env ?? process.env;
  if (
    env.GATEWAY_DATABASE_URL?.trim() &&
    !deps.connections &&
    !deps.credential
  ) {
    const row = await (
      deps.gatewayConnection ?? resolveGatewayComputerApiKeyConnection
    )({
      ...scope,
      providers: onlyKind ? [onlyKind] : [...COMPUTER_PROVIDER_KINDS],
    });
    if (!row || !isComputerKind(row.provider)) return null;
    const kind = row.provider;
    const build =
      deps.providers?.[kind] ??
      ((key: string) => sandboxProviderFor(kind, key, env));
    return {
      kind,
      provider: build(row.value),
      snapshot: row.metadata.snapshotName?.trim() || null,
      credential: "user",
      userId: scope.userId,
      connectionUpdatedAt: row.updatedAt,
    };
  }
  const connections = deps.connections ?? listProviderConnections;
  const credential = deps.credential ?? getTrustedProviderCredential;
  const candidates = (await connections(scope))
    .filter((row) => row.status === "connected" && row.authMethod === "api_key" && isComputerKind(row.provider))
    .filter((row) => onlyKind === null || row.provider === onlyKind)
    .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const row = candidates[0];
  if (!row || !isComputerKind(row.provider)) return null;
  const opened = await credential({ ...scope, provider: row.provider, authMethod: "api_key" });
  if (!opened || opened.authMethod !== "api_key" || typeof opened.value !== "string") return null;
  const kind = row.provider;
  const build = deps.providers?.[kind] ?? ((key: string) => sandboxProviderFor(kind, key, env));
  return {
    kind: row.provider,
    provider: build(opened.value),
    snapshot: row.metadata.snapshotName?.trim() || null,
    credential: "user",
    userId: scope.userId,
    connectionUpdatedAt: row.updatedAt.toISOString(),
  };
}

/** A new sandbox for this run: the user's own computer when allowed, else the server's. */
export async function resolveSandboxBindingForRun(
  scope: { readonly orgId?: string | null; readonly userId?: string | null },
  deps: SandboxBindingDeps = {},
): Promise<SandboxBinding> {
  if (userComputersEnabled(deps.env) && scope.orgId && scope.userId) {
    const user = await userSandboxBinding({ orgId: scope.orgId, userId: scope.userId }, null, deps);
    if (user) return user;
  }
  return requireEnvBinding(deps);
}

interface RecordedSandbox {
  readonly userId: string | null;
  readonly orgId: string | null;
  readonly sandboxProvider: string | null;
  readonly sandboxCredential: string | null;
}

async function bindingForRecorded(recorded: RecordedSandbox | null, deps: SandboxBindingDeps): Promise<SandboxBinding> {
  if (recorded?.sandboxCredential === "user") {
    if (!recorded.orgId || !recorded.userId || !isComputerKind(recorded.sandboxProvider)) {
      throw new Error(
        "this sandbox was created on a personal computer whose owner can no longer be resolved",
      );
    }
    const user = await userSandboxBinding({ orgId: recorded.orgId, userId: recorded.userId }, recorded.sandboxProvider, deps);
    if (!user) {
      throw new PersonalSandboxConnectionUnavailableError(
        `the ${recorded.sandboxProvider} connection that created this sandbox has been revoked`,
      );
    }
    return user;
  }
  if (recorded?.sandboxProvider !== null && recorded?.sandboxProvider !== undefined) {
    if (!isSandboxProviderKind(recorded.sandboxProvider)) {
      throw new Error(`recorded sandbox provider ${recorded.sandboxProvider} is unsupported`);
    }
    return requireRecordedEnvBinding(recorded.sandboxProvider, deps);
  }
  return requireEnvBinding(deps);
}

/** The provider that created the thread's current sandbox (org-scoped). */
export async function resolveSandboxBindingForThread(
  orgId: string,
  threadId: string,
  deps: SandboxBindingDeps = {},
): Promise<SandboxBinding> {
  const [recorded] = await db
    .select({ userId: runs.userId, orgId: runs.orgId, sandboxProvider: runs.sandboxProvider, sandboxCredential: runs.sandboxCredential })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.threadId, threadId), isNotNull(runs.sandboxId)))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return bindingForRecorded(recorded ?? null, deps);
}

/** The provider that created a sandbox, by sandbox id (for callers that hold only the id). */
export async function resolveSandboxBindingForSandbox(sandboxId: string, deps: SandboxBindingDeps = {}): Promise<SandboxBinding> {
  const [recorded] = await db
    .select({ userId: runs.userId, orgId: runs.orgId, sandboxProvider: runs.sandboxProvider, sandboxCredential: runs.sandboxCredential })
    .from(runs)
    .where(eq(runs.sandboxId, sandboxId))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return bindingForRecorded(recorded ?? null, deps);
}

/** The snapshot a binding creates from: the user's own, or the server's template for the lane. */
export function bindingSnapshot(binding: SandboxBinding, templateEnv: string): string {
  if (binding.credential === "user") return binding.snapshot ?? "";
  return sandboxTemplate(templateEnv);
}

/** What `setRunSandbox` records next to the sandbox id. */
export function bindingRecord(binding: SandboxBinding): { kind: SandboxProviderKind; credential: SandboxCredentialSource } {
  return { kind: binding.kind, credential: binding.credential };
}
