import { ENGINE_IDS, type EngineId } from "../db/schema";
import { mintSignedCapability, verifySignedCapability } from "../security/signed-capability";
import { PROVIDER_IDS, type ProviderId } from "./provider";

const TOKEN_OPTIONS = {
  deriveLabel: "skynet-provider-gateway-v1",
  get explicitSecret(): string | undefined {
    return process.env.PROVIDER_GATEWAY_SECRET;
  },
};

export interface ProviderTokenClaims {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly issuedRunId: string;
  readonly engine: EngineId;
  readonly provider: ProviderId;
  readonly exp: number;
}

interface WireClaims {
  readonly o: string;
  readonly u: string;
  readonly t: string;
  readonly r: string;
  readonly g: EngineId;
  readonly p: ProviderId;
}

export function mintProviderToken(
  claims: Omit<ProviderTokenClaims, "exp">,
  ttlMs: number,
): string {
  const wire: WireClaims = {
    o: claims.orgId,
    u: claims.userId,
    t: claims.threadId,
    r: claims.issuedRunId,
    g: claims.engine,
    p: claims.provider,
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
  return {
    orgId: wire.o,
    userId: wire.u,
    threadId: wire.t,
    issuedRunId: wire.r,
    engine: wire.g as EngineId,
    provider: wire.p as ProviderId,
    exp: verified.exp,
  };
}
