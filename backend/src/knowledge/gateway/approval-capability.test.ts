import { afterEach, describe, expect, test } from "bun:test";
import {
  approvalArgumentsHash,
  consumeApprovalCapability,
  consumeGatewayOperationApproval,
  mintApprovalCapability,
  type ApprovalBinding,
  type ApprovalCapabilityStore,
} from "./approval-capability";
import { verifyToolToken, type ToolTokenClaims } from "./token";

const originalFetch = globalThis.fetch;
const originalGatewayDatabaseUrl = process.env.GATEWAY_DATABASE_URL;
const originalApiOrigin = process.env.USEAGENT_API_ORIGIN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGatewayDatabaseUrl === undefined) delete process.env.GATEWAY_DATABASE_URL;
  else process.env.GATEWAY_DATABASE_URL = originalGatewayDatabaseUrl;
  if (originalApiOrigin === undefined) delete process.env.USEAGENT_API_ORIGIN;
  else process.env.USEAGENT_API_ORIGIN = originalApiOrigin;
});

class MemoryApprovalStore implements ApprovalCapabilityStore {
  readonly rows = new Map<string, ApprovalBinding & { consumed: boolean }>();

  async create(binding: ApprovalBinding): Promise<void> {
    this.rows.set(binding.nonce, { ...binding, consumed: false });
  }

  async consume(binding: ApprovalBinding, now: Date): Promise<boolean> {
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
  const minted = await mintApprovalCapability(
    { ...claims, toolName: "automation_update", arguments: args },
    store,
    ttlMs,
  );
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

    expect(await consumeApprovalCapability(input, store)).toBe(true);
    expect(await consumeApprovalCapability(input, store)).toBe(false);
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
