import { afterEach, describe, expect, test } from "bun:test";
import { evaluateAdmission } from "../src/fleet/capacity-policy";
import {
  queueReasonForDecision,
  type AdmissionRequest,
  type CapacityInventory,
} from "../src/fleet/types";
import {
  assertFanoutWithinLimit,
  FleetFanoutLimitError,
} from "../src/fleet/intake";
import { FakeInventoryProvider } from "../src/fleet/fake-provider.test-support";
import type { FleetCapacityConfig } from "../src/env";

// Pure CapacityPolicy tests — no DB, no provider. Every AdmissionDecision branch,
// the declared-resource reservation with a safety margin, and per-org vs global
// limits. Plus the provider TEST DOUBLE (inventory contract) and the server-side
// fan-out guard.

function makeConfig(over: Partial<FleetCapacityConfig> = {}): FleetCapacityConfig {
  return {
    globalMaxActiveSandboxes: 5,
    orgMaxActiveSandboxes: 3,
    orgMaxQueueDepth: 40,
    maxFanoutTasks: 20,
    maxDispatchConcurrency: 4,
    safetyMarginPct: 15,
    hostCpuMillicores: 12_000,
    hostMemoryMib: 63_488,
    leaseTtlMs: 1_200_000,
    tiers: {
      standard: { cpuMillicores: 2_000, memoryMib: 8_192 },
      desktop: { cpuMillicores: 4_000, memoryMib: 16_384 },
    },
    ...over,
  };
}

const REQUEST: AdmissionRequest = {
  orgId: "org-1",
  engine: "mock",
  model: "claude-opus-5",
  tier: "standard",
  cpuMillicores: 2_000,
  memoryMib: 8_192,
};

const EMPTY: CapacityInventory = {
  globalActiveSandboxes: 0,
  globalReservedCpuMillicores: 0,
  globalReservedMemoryMib: 0,
  orgActiveSandboxes: 0,
};

describe("capacity policy — decision branches", () => {
  test("admits when there is room everywhere", () => {
    expect(evaluateAdmission(REQUEST, EMPTY, makeConfig()).decision).toBe("admit");
  });

  test("queues on the GLOBAL active-sandbox limit", () => {
    const inv = { ...EMPTY, globalActiveSandboxes: 5 };
    expect(evaluateAdmission(REQUEST, inv, makeConfig()).decision).toBe(
      "queue_global_limit",
    );
  });

  test("queues on the PER-ORG limit even when the host has room", () => {
    // global room (2/5) but the org is at its cap (3/3).
    const inv = { ...EMPTY, globalActiveSandboxes: 2, orgActiveSandboxes: 3 };
    expect(evaluateAdmission(REQUEST, inv, makeConfig()).decision).toBe(
      "queue_org_limit",
    );
  });

  test("global limit is checked before the per-org limit", () => {
    // Both limits exceeded → the host-wide reason wins (checked first).
    const inv = { ...EMPTY, globalActiveSandboxes: 5, orgActiveSandboxes: 3 };
    expect(evaluateAdmission(REQUEST, inv, makeConfig()).decision).toBe(
      "queue_global_limit",
    );
  });

  test("rejects an invalid request (unknown tier / non-positive / oversized)", () => {
    const cfg = makeConfig();
    expect(
      evaluateAdmission(
        { ...REQUEST, tier: "gpu" as never },
        EMPTY,
        cfg,
      ).decision,
    ).toBe("reject_invalid_request");
    expect(
      evaluateAdmission({ ...REQUEST, cpuMillicores: 0 }, EMPTY, cfg).decision,
    ).toBe("reject_invalid_request");
    // Bigger than the whole margined host — would queue forever, so reject.
    expect(
      evaluateAdmission({ ...REQUEST, cpuMillicores: 999_999 }, EMPTY, cfg).decision,
    ).toBe("reject_invalid_request");
  });
});

describe("capacity policy — declared-resource reservation with safety margin", () => {
  // High count limits so the RESERVATION branch (not a count) governs.
  const cfg = makeConfig({ globalMaxActiveSandboxes: 100, orgMaxActiveSandboxes: 100 });
  // effective host cpu = floor(12000 * (1 - 0.15)) = 10200.

  test("admits while the declared reservation stays under the margined budget", () => {
    // 4 boxes reserved (8000) + this 2000 = 10000 <= 10200.
    const inv = { ...EMPTY, globalReservedCpuMillicores: 8_000 };
    expect(evaluateAdmission(REQUEST, inv, cfg).decision).toBe("admit");
  });

  test("queues on provider_capacity once the reservation would exceed the margin", () => {
    // 5 boxes reserved (10000) + this 2000 = 12000 > 10200 (would fit WITHOUT the
    // 15% margin — proves the margin reserves headroom, not resident RAM).
    const inv = { ...EMPTY, globalReservedCpuMillicores: 10_000 };
    expect(evaluateAdmission(REQUEST, inv, cfg).decision).toBe(
      "queue_provider_capacity",
    );
  });

  test("respects the memory budget independently of cpu", () => {
    // effective host mem = floor(63488 * 0.85) = 53964. Reserve just under, then
    // this 8192 pushes over.
    const inv = { ...EMPTY, globalReservedMemoryMib: 53_000 };
    expect(evaluateAdmission(REQUEST, inv, cfg).decision).toBe(
      "queue_provider_capacity",
    );
  });
});

describe("capacity policy — optional provider allocatable ceiling", () => {
  const cfg = makeConfig({ globalMaxActiveSandboxes: 100, orgMaxActiveSandboxes: 100 });

  test("queues when no provider node has enough allocatable cpu", () => {
    const inv: CapacityInventory = {
      ...EMPTY,
      providerAllocatableCpuMillicores: 1_000, // < request 2000
      providerAllocatableMemoryMib: 32_000,
    };
    expect(evaluateAdmission(REQUEST, inv, cfg).decision).toBe(
      "queue_provider_capacity",
    );
  });

  test("admits when the provider reports enough allocatable headroom", () => {
    const inv: CapacityInventory = {
      ...EMPTY,
      providerAllocatableCpuMillicores: 8_000,
      providerAllocatableMemoryMib: 32_000,
    };
    expect(evaluateAdmission(REQUEST, inv, cfg).decision).toBe("admit");
  });
});

describe("queueReasonForDecision mapping", () => {
  test("maps decisions to durable queue reasons", () => {
    expect(queueReasonForDecision("admit")).toBeNull();
    expect(queueReasonForDecision("queue_global_limit")).toBe("global_limit");
    expect(queueReasonForDecision("queue_org_limit")).toBe("org_limit");
    expect(queueReasonForDecision("queue_provider_capacity")).toBe("provider_capacity");
    expect(queueReasonForDecision("reject_invalid_request")).toBe("invalid_request");
  });
});

describe("provider test double implements the inventory contract", () => {
  test("create/get/list/inventory behave and track deletions", async () => {
    const provider = new FakeInventoryProvider({
      readyNodes: 3,
      allocatableCpuMillicores: 8_000,
      warmPoolReady: 1,
    });
    const box = await provider.create();
    expect(box.id).toBe("fake-1");
    const listed: string[] = [];
    for await (const sb of provider.list()) listed.push(sb.id);
    expect(listed).toEqual(["fake-1"]);
    await (await provider.get("fake-1")).delete();
    expect(provider.deleted).toEqual(["fake-1"]);
    expect(await provider.inventory()).toMatchObject({ readyNodes: 3, warmPoolReady: 1 });
  });
});

describe("server-side fan-out guard", () => {
  const original = process.env.FLEET_MAX_FANOUT_TASKS;
  afterEach(() => {
    if (original === undefined) delete process.env.FLEET_MAX_FANOUT_TASKS;
    else process.env.FLEET_MAX_FANOUT_TASKS = original;
  });

  test("throws past the configured task count", () => {
    process.env.FLEET_MAX_FANOUT_TASKS = "20";
    expect(() => assertFanoutWithinLimit(20)).not.toThrow();
    expect(() => assertFanoutWithinLimit(21)).toThrow(FleetFanoutLimitError);
  });
});
