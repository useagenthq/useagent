import {
  decodeIntegrationConnectionAccount,
  type ConnectionOwner,
  type ConnectionProjection,
  type IntegrationConnectionAccount,
  type IntegrationConnectionStatus,
} from "@useagent/agent-client/integrations";
import type {
  IntegrationConnectionAuthMethod,
  IntegrationConnectionOwnerType,
} from "../db/schema";

export type {
  ConnectionOwner,
  ConnectionProjection,
  IntegrationConnectionAccount,
  IntegrationConnectionAuthMethod,
  IntegrationConnectionOwnerType,
  IntegrationConnectionStatus,
};

export interface IntegrationConnectionScope {
  readonly orgId: string;
  readonly owner: ConnectionOwner;
}

export interface IntegrationConnectionActorScope {
  readonly orgId: string;
  readonly userId: string;
}

export function readSafeIntegrationAccount(value: unknown): IntegrationConnectionAccount {
  return decodeIntegrationConnectionAccount(value);
}

export function readSafeIntegrationScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const scope = item.trim();
    if (scope) seen.add(scope);
  }
  return [...seen];
}

export function ownerColumns(owner: ConnectionOwner): {
  ownerType: IntegrationConnectionOwnerType;
  ownerUserId: string | null;
} {
  return owner.type === "org"
    ? { ownerType: "org", ownerUserId: null }
    : {
        ownerType: "user",
        ownerUserId: requireNonEmptyIntegrationIdentifier(owner.userId, "owner.userId"),
      };
}

export function requireNonEmptyIntegrationIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}
