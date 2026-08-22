/** Browser-safe integration connection, catalog, and realtime wire contracts. */

export const INTEGRATION_CONNECTION_STATUSES = [
  "connecting",
  "connected",
  "reauth_required",
  "unhealthy",
  "revoked",
] as const;
export type IntegrationConnectionStatus = (typeof INTEGRATION_CONNECTION_STATUSES)[number];

export const INTEGRATION_CONNECTION_CHANGE_ACTIONS = [
  "created",
  "updated",
  "revoked",
  "health_changed",
] as const;
export type IntegrationConnectionChangeAction =
  (typeof INTEGRATION_CONNECTION_CHANGE_ACTIONS)[number];

export const INTEGRATION_ACTION_EFFECTS = ["read", "write", "destructive"] as const;
export type IntegrationActionEffect = (typeof INTEGRATION_ACTION_EFFECTS)[number];

export const INTEGRATION_ACTION_APPROVALS = ["none", "interactive", "disabled"] as const;
export type IntegrationActionApproval = (typeof INTEGRATION_ACTION_APPROVALS)[number];

export type ConnectionOwner =
  | { readonly type: "org" }
  | { readonly type: "user"; readonly userId: string };

export interface IntegrationConnectionAccount {
  readonly externalAccountId?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly avatarUrl?: string;
}

export interface ConnectionProjection {
  readonly id: string;
  readonly provider: string;
  readonly owner: ConnectionOwner;
  readonly status: IntegrationConnectionStatus;
  readonly account: IntegrationConnectionAccount;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastVerifiedAt: string | null;
  readonly revokedAt: string | null;
}

export interface IntegrationConnectionChange {
  readonly type: "integration_connection";
  readonly action: IntegrationConnectionChangeAction;
  readonly connectionId: string;
  readonly provider: string;
  readonly targetUserId?: string;
}

export interface IntegrationActionCatalogEntry {
  readonly catalogVersion: 1;
  readonly runtimeVersion: "1.4.0";
  readonly runtimeCommit: "96fb6afe8c244c7d6f3a8351df06d7b04137f6a6";
  readonly provider: string;
  readonly actionId: string;
  readonly publicName: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly effect: IntegrationActionEffect;
  readonly approval: IntegrationActionApproval;
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
  readonly idempotent: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return nonEmptyString(value) ?? undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isIntegrationConnectionStatus(value: unknown): value is IntegrationConnectionStatus {
  return (
    typeof value === "string" &&
    (INTEGRATION_CONNECTION_STATUSES as readonly string[]).includes(value)
  );
}

function isIntegrationConnectionChangeAction(
  value: unknown,
): value is IntegrationConnectionChangeAction {
  return (
    typeof value === "string" &&
    (INTEGRATION_CONNECTION_CHANGE_ACTIONS as readonly string[]).includes(value)
  );
}

function isIntegrationActionEffect(value: unknown): value is IntegrationActionEffect {
  return (
    typeof value === "string" &&
    (INTEGRATION_ACTION_EFFECTS as readonly string[]).includes(value)
  );
}

function isIntegrationActionApproval(value: unknown): value is IntegrationActionApproval {
  return (
    typeof value === "string" &&
    (INTEGRATION_ACTION_APPROVALS as readonly string[]).includes(value)
  );
}

export function decodeConnectionOwner(value: unknown): ConnectionOwner | null {
  if (!isRecord(value)) return null;
  if (value.type === "org") return { type: "org" };
  if (value.type !== "user") return null;
  const userId = nonEmptyString(value.userId);
  return userId ? { type: "user", userId } : null;
}

export function decodeIntegrationConnectionAccount(
  value: unknown,
): IntegrationConnectionAccount {
  if (!isRecord(value)) return {};
  const account: {
    externalAccountId?: string;
    displayName?: string;
    email?: string;
    avatarUrl?: string;
  } = {};
  for (const key of ["externalAccountId", "displayName", "email", "avatarUrl"] as const) {
    const decoded = nonEmptyString(value[key]);
    if (decoded) account[key] = decoded;
  }
  return account;
}

export function decodeConnectionProjection(value: unknown): ConnectionProjection | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const provider = nonEmptyString(value.provider);
  const owner = decodeConnectionOwner(value.owner);
  const createdAt = nonEmptyString(value.createdAt);
  const updatedAt = nonEmptyString(value.updatedAt);
  const lastVerifiedAt = nullableString(value.lastVerifiedAt);
  const revokedAt = nullableString(value.revokedAt);
  if (
    !id ||
    !provider ||
    !owner ||
    !isIntegrationConnectionStatus(value.status) ||
    !isRecord(value.account) ||
    !Array.isArray(value.scopes) ||
    !createdAt ||
    !updatedAt ||
    lastVerifiedAt === undefined ||
    revokedAt === undefined
  ) {
    return null;
  }
  const scopes = value.scopes.map(nonEmptyString);
  if (scopes.some((scope) => scope === null)) return null;
  return {
    id,
    provider,
    owner,
    status: value.status,
    account: decodeIntegrationConnectionAccount(value.account),
    scopes: scopes as string[],
    createdAt,
    updatedAt,
    lastVerifiedAt,
    revokedAt,
  };
}

export function decodeConnectionProjections(value: unknown): ConnectionProjection[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(decodeConnectionProjection)
    .filter((connection): connection is ConnectionProjection => connection !== null);
}

export function decodeIntegrationConnectionChange(
  value: unknown,
): IntegrationConnectionChange | null {
  if (!isRecord(value)) return null;
  const connectionId = nonEmptyString(value.connectionId);
  const provider = nonEmptyString(value.provider);
  const targetUserId = value.targetUserId === undefined
    ? undefined
    : nonEmptyString(value.targetUserId) ?? null;
  if (
    value.type !== "integration_connection" ||
    !isIntegrationConnectionChangeAction(value.action) ||
    !connectionId ||
    !provider ||
    targetUserId === null
  ) {
    return null;
  }
  return {
    type: value.type,
    action: value.action,
    connectionId,
    provider,
    ...(targetUserId ? { targetUserId } : {}),
  };
}

export function decodeIntegrationActionCatalogEntry(
  value: unknown,
): IntegrationActionCatalogEntry | null {
  if (!isRecord(value)) return null;
  const provider = nonEmptyString(value.provider);
  const actionId = nonEmptyString(value.actionId);
  const publicName = nonEmptyString(value.publicName);
  if (
    value.catalogVersion !== 1 ||
    value.runtimeVersion !== "1.4.0" ||
    value.runtimeCommit !== "96fb6afe8c244c7d6f3a8351df06d7b04137f6a6" ||
    !provider ||
    !actionId ||
    !publicName ||
    typeof value.description !== "string" ||
    !isRecord(value.inputSchema) ||
    !isIntegrationActionEffect(value.effect) ||
    !isIntegrationActionApproval(value.approval) ||
    !isPositiveInteger(value.timeoutMs) ||
    !isPositiveInteger(value.maxResultBytes) ||
    typeof value.idempotent !== "boolean"
  ) {
    return null;
  }
  return {
    catalogVersion: value.catalogVersion,
    runtimeVersion: value.runtimeVersion,
    runtimeCommit: value.runtimeCommit,
    provider,
    actionId,
    publicName,
    description: value.description,
    inputSchema: value.inputSchema,
    effect: value.effect,
    approval: value.approval,
    timeoutMs: value.timeoutMs,
    maxResultBytes: value.maxResultBytes,
    idempotent: value.idempotent,
  };
}

export function decodeIntegrationActionCatalog(
  value: unknown,
): IntegrationActionCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(decodeIntegrationActionCatalogEntry)
    .filter((entry): entry is IntegrationActionCatalogEntry => entry !== null);
}
