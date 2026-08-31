import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  mintSignedCapability,
  verifySignedCapability,
} from "../../security/signed-capability";
import { mintToolToken, type ToolTokenClaims } from "./token";

const APPROVAL_TTL_MS = 2 * 60_000;
const OPAQUE_APPROVAL_VERSION = "apr1";
const APPROVAL_MINT_MODES = ["signed", "opaque"] as const;
type ApprovalMintMode = (typeof APPROVAL_MINT_MODES)[number];
const TOKEN_OPTIONS = {
  deriveLabel: "skynet-gateway-operation-approval-v1",
  get explicitSecret(): string | undefined {
    return process.env.TOOL_GATEWAY_SECRET;
  },
};

/** Legacy self-contained token claims accepted only for rolling compatibility. */
interface ApprovalWireClaims {
  readonly o: string;
  readonly u: string;
  readonly t: string;
  readonly r: string;
  readonly n: string;
  readonly w: string;
  readonly h: string;
}

export interface ApprovalBinding {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly toolName: string;
  readonly argumentsHash: string;
  readonly nonce: string;
  readonly expiresAt: Date;
}

export interface ApprovalCapabilityStore {
  create(binding: ApprovalBinding): Promise<void>;
  consume(binding: Omit<ApprovalBinding, "expiresAt">, now: Date): Promise<boolean>;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("approval arguments must be JSON values");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") {
    throw new TypeError("approval arguments must be JSON values");
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

/** The capability itself is transport metadata, never part of the approved operation. */
export function argumentsWithoutApproval(
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized = { ...args };
  delete normalized.approvalCapability;
  return normalized;
}

export function approvalArgumentsHash(args: Readonly<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(canonicalJson(argumentsWithoutApproval(args)))
    .digest("hex");
}

export function approvalCapabilityMintMode(
  env: Record<string, string | undefined> = process.env,
): ApprovalMintMode {
  const raw = env.GATEWAY_APPROVAL_CAPABILITY_MINT?.trim().toLowerCase();
  if (!raw) return "signed";
  if (raw === "signed" || raw === "opaque") return raw;
  throw new Error("GATEWAY_APPROVAL_CAPABILITY_MINT must be signed or opaque");
}

export const databaseApprovalCapabilityStore: ApprovalCapabilityStore = {
  async create(binding) {
    await db.execute(sql`
      delete from gateway_operation_approvals
      where expires_at <= now()
    `);
    await db.execute(sql`
      insert into gateway_operation_approvals (
        nonce, org_id, user_id, thread_id, run_id, tool_name,
        arguments_hash, expires_at
      ) values (
        ${binding.nonce}, ${binding.orgId}, ${binding.userId},
        ${binding.threadId}, ${binding.runId}, ${binding.toolName},
        ${binding.argumentsHash}, ${binding.expiresAt.toISOString()}::timestamptz
      )
    `);
  },

  async consume(binding, now) {
    const consumed = await db.execute(sql`
      update gateway_operation_approvals
      set consumed_at = ${now.toISOString()}::timestamptz
      where nonce = ${binding.nonce}
        and org_id = ${binding.orgId}
        and user_id = ${binding.userId}
        and thread_id = ${binding.threadId}
        and run_id = ${binding.runId}
        and tool_name = ${binding.toolName}
        and arguments_hash = ${binding.argumentsHash}
        and expires_at > ${now.toISOString()}::timestamptz
        and consumed_at is null
      returning nonce
    `);
    return consumed.length === 1;
  },
};

export async function mintApprovalCapability(
  input: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly toolName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  },
  store: ApprovalCapabilityStore = databaseApprovalCapabilityStore,
  ttlMs = APPROVAL_TTL_MS,
): Promise<{ readonly capability: string; readonly expiresAt: Date; readonly argumentsHash: string }> {
  const boundedTtlMs = Math.min(APPROVAL_TTL_MS, Math.max(1, ttlMs));
  const nonce = randomUUID();
  const argumentsHash = approvalArgumentsHash(input.arguments);
  const mode = approvalCapabilityMintMode();
  let expiresAt = new Date(Date.now() + boundedTtlMs);
  const capability = mode === "opaque"
    // Keep model-visible transport short. The UUID is a random bearer secret;
    // every authority-bearing field remains in the server-side one-shot ledger
    // and is matched again atomically during consumption.
    ? `${OPAQUE_APPROVAL_VERSION}.${nonce}`
    : mintSignedCapability<ApprovalWireClaims>(
        {
          o: input.orgId,
          u: input.userId,
          t: input.threadId,
          r: input.runId,
          n: nonce,
          w: input.toolName,
          h: argumentsHash,
        },
        boundedTtlMs,
        TOKEN_OPTIONS,
      );
  if (mode === "signed") {
    const verified = verifySignedCapability(capability, TOKEN_OPTIONS);
    if (!verified) throw new Error("failed to mint gateway approval capability");
    expiresAt = new Date(verified.exp);
  }
  await store.create({
    orgId: input.orgId,
    userId: input.userId,
    threadId: input.threadId,
    runId: input.runId,
    toolName: input.toolName,
    argumentsHash,
    nonce,
    expiresAt,
  });
  return { capability, expiresAt, argumentsHash };
}

function capabilityBinding(
  capability: string | null | undefined,
  claims: ToolTokenClaims,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  nowMs: number,
): Omit<ApprovalBinding, "expiresAt"> | null {
  const opaqueNonce = capability?.startsWith(`${OPAQUE_APPROVAL_VERSION}.`)
    ? capability.slice(OPAQUE_APPROVAL_VERSION.length + 1)
    : null;
  if (opaqueNonce && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(opaqueNonce)) {
    return {
      orgId: claims.orgId,
      userId: claims.userId,
      threadId: claims.threadId,
      runId: claims.runId,
      toolName,
      argumentsHash: approvalArgumentsHash(args),
      nonce: opaqueNonce,
    };
  }

  // Rolling compatibility: capabilities minted by the previous release remain
  // usable until their normal two-minute expiry.
  const verified = verifySignedCapability(capability, TOKEN_OPTIONS, nowMs);
  if (!verified?.claims || typeof verified.claims !== "object") return null;
  const wire = verified.claims as Partial<ApprovalWireClaims>;
  const argumentsHash = approvalArgumentsHash(args);
  if (
    wire.o !== claims.orgId ||
    wire.u !== claims.userId ||
    wire.t !== claims.threadId ||
    wire.r !== claims.runId ||
    wire.w !== toolName ||
    wire.h !== argumentsHash ||
    typeof wire.n !== "string" ||
    wire.n.length === 0
  ) {
    return null;
  }
  return {
    orgId: wire.o,
    userId: wire.u,
    threadId: wire.t,
    runId: wire.r,
    toolName: wire.w,
    argumentsHash: wire.h,
    nonce: wire.n,
  };
}

export async function consumeApprovalCapability(
  input: {
    readonly capability: string | null | undefined;
    readonly claims: ToolTokenClaims;
    readonly toolName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  },
  store: ApprovalCapabilityStore = databaseApprovalCapabilityStore,
  nowMs = Date.now(),
): Promise<boolean> {
  const binding = capabilityBinding(
    input.capability,
    input.claims,
    input.toolName,
    input.arguments,
    nowMs,
  );
  return binding ? store.consume(binding, new Date(nowMs)) : false;
}

function primaryApiOrigin(): string | null {
  if (!process.env.GATEWAY_DATABASE_URL) return null;
  const raw = process.env.USEAGENT_API_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Consume on the primary backend when this code runs inside the restricted
 * public gateway process. The short-lived run token authenticates the bridge;
 * the approval token and arguments are still verified and atomically consumed
 * by the primary database owner.
 */
export async function consumeGatewayOperationApproval(
  claims: ToolTokenClaims,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  if (!process.env.GATEWAY_DATABASE_URL) {
    return consumeApprovalCapability({
      capability:
        typeof args.approvalCapability === "string" ? args.approvalCapability : null,
      claims,
      toolName,
      arguments: args,
    });
  }
  const origin = primaryApiOrigin();
  if (!origin) return false;
  const remainingTtlMs = Math.max(1, Math.min(30_000, claims.exp - Date.now()));
  const runToken = mintToolToken(
    {
      orgId: claims.orgId,
      userId: claims.userId,
      threadId: claims.threadId,
      runId: claims.runId,
      scope: claims.scope,
    },
    remainingTtlMs,
  );
  const response = await fetch(`${origin}/api/internal/gateway-approval/consume`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ toolName, arguments: args }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!response?.ok) return false;
  const body = (await response.json().catch(() => null)) as { approved?: unknown } | null;
  return body?.approved === true;
}
