import { describe, expect, test } from "bun:test";
import {
  assertCanonicalExecutionTranscriptIndexForBoot,
  classifyCanonicalExecutionIndex,
  type CanonicalExecutionIndexCatalogRow,
} from "./canonical-execution-transcript";

function catalogRow(
  overrides: Partial<CanonicalExecutionIndexCatalogRow> = {},
): CanonicalExecutionIndexCatalogRow {
  return {
    schema_name: "public",
    table_name: "canonical_events",
    index_name: "idx_canonical_events_execution_delivery_v1",
    access_method: "btree",
    predicate: null,
    total_attributes: 4,
    key_attributes: 4,
    is_unique: false,
    is_valid: true,
    is_ready: true,
    is_live: true,
    key_expressions: [
      "run_id",
      "(identity ->> 'provider'::text)",
      "(identity ->> 'nativeSessionId'::text)",
      "delivery_seq",
    ],
    ...overrides,
  };
}

describe("canonical execution transcript online index catalog", () => {
  test("classifies absent and the exact ready definition", () => {
    expect(classifyCanonicalExecutionIndex([])).toEqual({ kind: "absent" });
    expect(classifyCanonicalExecutionIndex([catalogRow()])).toEqual({ kind: "exact-valid" });
  });

  test("distinguishes invalid residue from valid definition mismatch", () => {
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ is_valid: false, is_ready: false }),
    ])).toMatchObject({ kind: "invalid-residue" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ key_expressions: ["run_id", "delivery_seq"] }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ table_name: "provider_events" }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ table_name: "provider_events", is_valid: false }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ predicate: "false" }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ total_attributes: 5 }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ access_method: "hash" }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ is_unique: true }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ predicate: "false", is_valid: false, is_ready: false }),
    ])).toMatchObject({ kind: "valid-mismatch" });
    expect(classifyCanonicalExecutionIndex([
      catalogRow({ total_attributes: 5, is_valid: false, is_live: false }),
    ])).toMatchObject({ kind: "valid-mismatch" });
  });
});

describe("canonical execution transcript READ boot guard", () => {
  test("does not require the index in OFF or SHADOW", async () => {
    let calls = 0;
    const verify = async () => { calls += 1; };
    await assertCanonicalExecutionTranscriptIndexForBoot({}, verify);
    await assertCanonicalExecutionTranscriptIndexForBoot(
      { EXECUTION_GRAPH_ROLLOUT: "shadow" },
      verify,
    );
    expect(calls).toBe(0);
  });

  test("requires successful verification before READ can boot", async () => {
    let calls = 0;
    await assertCanonicalExecutionTranscriptIndexForBoot(
      { EXECUTION_GRAPH_ROLLOUT: " READ " },
      async () => { calls += 1; },
    );
    expect(calls).toBe(1);
    await expect(assertCanonicalExecutionTranscriptIndexForBoot(
      { EXECUTION_GRAPH_ROLLOUT: "read" },
      async () => { throw new Error("index missing"); },
    )).rejects.toThrow("index missing");
  });
});
