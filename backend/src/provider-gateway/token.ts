import { ENGINE_IDS, type EngineId } from "../db/schema";
import { mintSignedCapability, verifySignedCapability } from "../security/signed-capability";
import { PROVIDER_IDS, type ProviderId } from "./provider";

const TOKEN_OPTIONS = {
  deriveLabel: "skynet-provider-gateway-v1",
  get explicitSecret(): string | undefined {
    return process.env.PROVIDER_GATEWAY_SECRET;
  },
};

/** How the capability binds to a turn (perf plan run-invariant-config slice):
 *  - "run": usable ONLY while the exact minted run is running (the original
 *    model - a warm process's older token is inert on later turns).
 *  - "thread": usable while THIS thread has ANY currently-running turn on the
 *    minted engine; the gateway resolves that live run per request and keys all
 *    enforcement (model policy, budgets, audit) to the RESOLVED run. This is a
 *    deliberate, documented relaxation that lets a resident OpenCode process
 *    keep a byte-stable config across warm turns; outside a live turn the token
 *    stays inert (fail closed), and the TTL bound is unchanged. */
export type ProviderTokenScope = "run" | "thread";

export interface ProviderTokenClaims {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  /** The run the token was minted during. Identity authority for "run" scope;
   *  provenance only for "thread" scope (enforcement uses the resolved run). */
  readonly issuedRunId: string;
  readonly engine: EngineId;
  readonly provider: ProviderId;
  readonly scope: ProviderTokenScope;
  readonly exp: number;
}

interface WireClaims {
  readonly o: string;
  readonly u: string;
  readonly t: string;
  readonly r: string;
  readonly g: EngineId;
  readonly p: ProviderId;
  /** Scope marker; absent (legacy tokens) means "run". */
  readonly k?: "t";
}

export function mintProviderToken(
  claims: Omit<ProviderTokenClaims, "exp" | "scope"> & { scope?: ProviderTokenScope },
  ttlMs: number,
): string {
  const wire: WireClaims = {
    o: claims.orgId,
    u: claims.userId,
    t: claims.threadId,
    r: claims.issuedRunId,
    g: claims.engine,
    p: claims.provider,
    ...(claims.scope === "thread" ? { k: "t" as const } : {}),
  };
  return mintSignedCapability(wire, ttlMs, TOKEN_OPTIONS);
}

export function verifyProviderToken(
  token: string | null | undefined,
  nowMs = Date.now(),
): ProviderTokenClaims | null {
  const verified = verifySignedCapability(token, TOKEN_OPTIONS, nowMs);
  if (!verified?.claims || typeof verified.claims !== "object") return null;
  const wire = verified.claims as Partial<WireClaims>;
  if (
    typeof wire.o !== "string" ||
    wire.o.length === 0 ||
    typeof wire.u !== "string" ||
    typeof wire.t !== "string" ||
    wire.t.length === 0 ||
    typeof wire.r !== "string" ||
    wire.r.length === 0 ||
    typeof wire.g !== "string" ||
    !ENGINE_IDS.includes(wire.g as EngineId) ||
    typeof wire.p !== "string" ||
    !PROVIDER_IDS.includes(wire.p as ProviderId)
  ) {
    return null;
  }
  if (wire.k !== undefined && wire.k !== "t") return null;
  return {
    orgId: wire.o,
    userId: wire.u,
    threadId: wire.t,
    issuedRunId: wire.r,
    engine: wire.g as EngineId,
    provider: wire.p as ProviderId,
    scope: wire.k === "t" ? "thread" : "run",
    exp: verified.exp,
  };
}
