import { afterEach, describe, expect, test } from "bun:test";
import {
  approvalArgumentsHash,
  approvalCapabilityMintMode,
  consumeApprovalCapability,
  consumeGatewayOperationApproval,
  mintApprovalCapability,
  type ApprovalBinding,
  type ApprovalCapabilityStore,
} from "./approval-capability";
import { verifyToolToken, type ToolTokenClaims } from "./token";
import { mintSignedCapability } from "../../security/signed-capability";

const originalFetch = globalThis.fetch;
const originalGatewayDatabaseUrl = process.env.GATEWAY_DATABASE_URL;
const originalApiOrigin = process.env.USEAGENT_API_ORIGIN;
const originalToolGatewaySecret = process.env.TOOL_GATEWAY_SECRET;
const originalApprovalMintMode = process.env.GATEWAY_APPROVAL_CAPABILITY_MINT;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGatewayDatabaseUrl === undefined) delete process.env.GATEWAY_DATABASE_URL;
  else process.env.GATEWAY_DATABASE_URL = originalGatewayDatabaseUrl;
  if (originalApiOrigin === undefined) delete process.env.USEAGENT_API_ORIGIN;
  else process.env.USEAGENT_API_ORIGIN = originalApiOrigin;
  if (originalToolGatewaySecret === undefined) delete process.env.TOOL_GATEWAY_SECRET;
  else process.env.TOOL_GATEWAY_SECRET = originalToolGatewaySecret;
  if (originalApprovalMintMode === undefined) delete process.env.GATEWAY_APPROVAL_CAPABILITY_MINT;
  else process.env.GATEWAY_APPROVAL_CAPABILITY_MINT = originalApprovalMintMode;
});

class MemoryApprovalStore implements ApprovalCapabilityStore {
  readonly rows = new Map<string, ApprovalBinding & { consumed: boolean }>();

  async create(binding: ApprovalBinding): Promise<void> {
    this.rows.set(binding.nonce, { ...binding, consumed: false });
  }

  async consume(binding: Omit<ApprovalBinding, "expiresAt">, now: Date): Promise<boolean> {
    const row = this.rows.get(binding.nonce);
    if (
      !row ||
      row.consumed ||
      row.expiresAt <= now ||
      row.orgId !== binding.orgId ||
      row.userId !== binding.userId ||
      row.threadId !== binding.threadId ||
      row.runId !== binding.runId ||
      row.toolName !== binding.toolName ||
      row.argumentsHash !== binding.argumentsHash
    ) {
      return false;
    }
    row.consumed = true;
    return true;
  }
}

const claims = {
  orgId: "org-a",
  userId: "user-a",
  threadId: "thread-a",
  runId: "run-a",
  scope: "run",
  exp: Date.now() + 60_000,
} as const satisfies ToolTokenClaims;

async function approvedCall(store: ApprovalCapabilityStore, ttlMs = 60_000) {
  const args = { id: "automation-1", enabled: true };
  const previous = process.env.GATEWAY_APPROVAL_CAPABILITY_MINT;
  process.env.GATEWAY_APPROVAL_CAPABILITY_MINT = "opaque";
  const minted = await mintApprovalCapability(
    { ...claims, toolName: "automation_update", arguments: args },
    store,
    ttlMs,
  ).finally(() => {
    if (previous === undefined) delete process.env.GATEWAY_APPROVAL_CAPABILITY_MINT;
    else process.env.GATEWAY_APPROVAL_CAPABILITY_MINT = previous;
  });
  return { ...minted, args };
}

describe("gateway operation approval capability", () => {
  test("normalizes object key order but preserves exact nested values and array order", () => {
    expect(approvalArgumentsHash({ b: 2, a: { y: [1, 2], x: true } })).toBe(
      approvalArgumentsHash({ a: { x: true, y: [1, 2] }, b: 2 }),
    );
    expect(approvalArgumentsHash({ ids: ["a", "b"] })).not.toBe(
      approvalArgumentsHash({ ids: ["b", "a"] }),
    );
    expect(approvalArgumentsHash({ id: "x", approvalCapability: "ignored" })).toBe(
      approvalArgumentsHash({ id: "x" }),
    );
  });

  test("accepts the exact bound org, user, thread, run, tool, and arguments once", async () => {
    const store = new MemoryApprovalStore();
    const { capability, args } = await approvedCall(store);
    const input = {
      capability,
      claims,
      toolName: "automation_update",
      arguments: args,
    } as const;

    expect(capability).toMatch(/^apr1\.[0-9a-f-]{36}$/);
    expect(capability.length).toBeLessThan(64);

    expect(await consumeApprovalCapability(input, store)).toBe(true);
    expect(await consumeApprovalCapability(input, store)).toBe(false);
  });

  test("defaults to rollback-compatible signed minting and gates opaque minting explicitly", async () => {
    delete process.env.GATEWAY_APPROVAL_CAPABILITY_MINT;
    process.env.TOOL_GATEWAY_SECRET = "approval-mode-test-secret-0123456789";
    const signedStore = new MemoryApprovalStore();
    const args = { id: "automation-1" };
    const signed = await mintApprovalCapability(
      { ...claims, toolName: "automation_delete", arguments: args },
      signedStore,
    );
    expect(approvalCapabilityMintMode()).toBe("signed");
    expect(signed.capability).toMatch(/^v1\./);
    expect(await consumeApprovalCapability({
      capability: signed.capability,
      claims,
      toolName: "automation_delete",
      arguments: args,
    }, signedStore)).toBe(true);

    process.env.GATEWAY_APPROVAL_CAPABILITY_MINT = "opaque";
    const opaque = await mintApprovalCapability(
      { ...claims, toolName: "automation_delete", arguments: args },
      new MemoryApprovalStore(),
    );
    expect(approvalCapabilityMintMode()).toBe("opaque");
    expect(opaque.capability).toMatch(/^apr1\.[0-9a-f-]{36}$/);

    process.env.GATEWAY_APPROVAL_CAPABILITY_MINT = "invalid";
    expect(() => approvalCapabilityMintMode()).toThrow("must be signed or opaque");
  });

  test("rejects invented and malformed opaque approval handles", async () => {
    const store = new MemoryApprovalStore();
    const { args } = await approvedCall(store);
    for (const capability of ["apr1.not-a-uuid", `apr1.${crypto.randomUUID()}`, "approve"]) {
      expect(
        await consumeApprovalCapability({
          capability,
          claims,
          toolName: "automation_update",
          arguments: args,
        }, store),
      ).toBe(false);
    }
    expect([...store.rows.values()].every((row) => !row.consumed)).toBe(true);
  });

  test("accepts a still-live signed capability from the previous release", async () => {
    process.env.TOOL_GATEWAY_SECRET = "test-only-placeholder-test-only-placeholder";
    const store = new MemoryApprovalStore();
    const args = { id: "automation-1", enabled: true };
    const nonce = crypto.randomUUID();
    const argumentsHash = approvalArgumentsHash(args);
    const expiresAt = new Date(Date.now() + 60_000);
    await store.create({
      orgId: claims.orgId,
      userId: claims.userId,
      threadId: claims.threadId,
      runId: claims.runId,
      toolName: "automation_update",
      argumentsHash,
      nonce,
      expiresAt,
    });
    const capability = mintSignedCapability(
      {
        o: claims.orgId,
        u: claims.userId,
        t: claims.threadId,
        r: claims.runId,
        n: nonce,
        w: "automation_update",
        h: argumentsHash,
      },
      60_000,
      {
        deriveLabel: "skynet-gateway-operation-approval-v1",
        explicitSecret: process.env.TOOL_GATEWAY_SECRET,
      },
    );

    expect(
      await consumeApprovalCapability({
        capability,
        claims,
        toolName: "automation_update",
        arguments: args,
      }, store),
    ).toBe(true);
  });

  test("rejects cross-user, cross-run, cross-tool, and changed-argument use", async () => {
    const variants: readonly {
      readonly claims?: ToolTokenClaims;
      readonly toolName?: string;
      readonly arguments?: Readonly<Record<string, unknown>>;
    }[] = [
      { claims: { ...claims, orgId: "org-b" } },
      { claims: { ...claims, userId: "user-b" } },
      { claims: { ...claims, threadId: "thread-b" } },
      { claims: { ...claims, runId: "run-b" } },
      { toolName: "automation_delete" },
      { arguments: { id: "automation-2", enabled: true } },
    ];

    for (const variant of variants) {
      const store = new MemoryApprovalStore();
      const { capability, args } = await approvedCall(store);
      expect(
        await consumeApprovalCapability(
          {
            capability,
            claims: variant.claims ?? claims,
            toolName: variant.toolName ?? "automation_update",
            arguments: variant.arguments ?? args,
          },
          store,
        ),
      ).toBe(false);
    }
  });

  test("rejects expiry before touching the single-use store", async () => {
    const store = new MemoryApprovalStore();
    const { capability, expiresAt, args } = await approvedCall(store, 5);
    expect(
      await consumeApprovalCapability(
        {
          capability,
          claims,
          toolName: "automation_update",
          arguments: args,
        },
        store,
        expiresAt.getTime(),
      ),
    ).toBe(false);
    expect([...store.rows.values()][0]?.consumed).toBe(false);
  });

  test("restricted gateway delegates atomic consumption to the authenticated primary API", async () => {
    process.env.GATEWAY_DATABASE_URL = "postgres://restricted";
    process.env.USEAGENT_API_ORIGIN = "http://127.0.0.1:3201/path-is-ignored";
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push(input instanceof Request ? input : new Request(input.toString(), init));
      return Response.json({ approved: true });
    }) as typeof fetch;

    const approved = await consumeGatewayOperationApproval(
      claims,
      "knowledge_draft_publish",
      { documentId: "doc-a", approvalCapability: "signed-approval" },
    );

    expect(approved).toBe(true);
    const request = requests[0];
    expect(request).toBeDefined();
    if (!request) throw new Error("expected primary approval consumption request");
    expect(request.url).toBe(
      "http://127.0.0.1:3201/api/internal/gateway-approval/consume",
    );
    const authorization = request.headers.get("authorization") ?? "";
    expect(verifyToolToken(authorization.replace(/^Bearer\s+/, ""))).toMatchObject({
      orgId: claims.orgId,
      userId: claims.userId,
      threadId: claims.threadId,
      runId: claims.runId,
    });
    expect(await request.json()).toEqual({
      toolName: "knowledge_draft_publish",
      arguments: { documentId: "doc-a", approvalCapability: "signed-approval" },
    });
  });
});
