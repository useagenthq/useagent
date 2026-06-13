import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Sql } from "postgres";
import {
  applyGatewayGrants,
  GATEWAY_GRANTS,
  gatewayDatabaseRoleRequired,
} from "./gateway-grants";

/** Normalize a GRANT statement for comparison: collapse whitespace, drop the
 *  trailing semicolon, uppercase keywords are already literal in both sources. */
function normalize(grant: string): string {
  return grant.replace(/\s+/g, " ").replace(/;$/, "").trim();
}

/** Extract every `GRANT ... TO useagent_gateway;` from the provisioning script,
 *  joining continuation lines, excluding the credentials VIEW grant (the view
 *  is provisioning-owned; boot grants it only when present). */

describe("gateway grants single source of truth", () => {

  test("requires the hosted role only when the backend enables its restricted gateway", () => {
    expect(gatewayDatabaseRoleRequired({ NODE_ENV: "production" })).toBe(false);
    expect(gatewayDatabaseRoleRequired({ GATEWAY_PUBLIC_URL: "  " })).toBe(false);
    expect(gatewayDatabaseRoleRequired({
      GATEWAY_PUBLIC_URL: "https://gateway.example.test",
    })).toBe(true);
  });

  test("uses the gateway flag visible to backend in both Compose environments", () => {
    for (const path of ["../../../compose.local.yaml", "../../../compose.prod.yaml"]) {
      const compose = readFileSync(new URL(path, import.meta.url), "utf8");
      const backend = compose.split("\n  gateway:\n", 1)[0] ?? "";
      expect(backend).toContain("GATEWAY_PUBLIC_URL:");
      expect(backend).not.toContain("GATEWAY_DATABASE_URL:");
    }
  });

  test("least privilege holds: no DELETE, no ALL, no provider_connections table grant", () => {
    for (const grant of GATEWAY_GRANTS) {
      expect(grant).not.toMatch(/\bDELETE\b/);
      expect(grant).not.toMatch(/\bALL\b/);
      expect(grant).not.toMatch(/ON provider_connections\b/);
    }
    expect(GATEWAY_GRANTS).toContain(
      "GRANT UPDATE (status, resolved_at, resolved_by, resolved_revision) ON artifact_workpiece_proposals TO useagent_gateway",
    );
  });

  test("restricted gateway can persist tasks and read connected integration credentials", () => {
    expect(GATEWAY_GRANTS).toEqual(
      expect.arrayContaining([
        "GRANT SELECT, INSERT ON projects TO useagent_gateway",
        "GRANT UPDATE (repo_full_name, updated_at) ON projects TO useagent_gateway",
        "GRANT SELECT, INSERT ON tasks TO useagent_gateway",
        "GRANT UPDATE (title, body, status, priority, order_key, updated_at) ON tasks TO useagent_gateway",
        "GRANT SELECT ON integration_connections, integration_connection_credentials TO useagent_gateway",
      ]),
    );
  });

  test("restricted gateway can persist its FinishedWork obligations and receipts", () => {
    expect(GATEWAY_GRANTS).toEqual(expect.arrayContaining([
      "GRANT SELECT, INSERT ON finished_work_obligations, finished_work_receipts TO useagent_gateway",
      "GRANT UPDATE (state, materialized_artifact_id, materialized_artifact_revision, failure_code, resolved_at, updated_at) ON finished_work_obligations TO useagent_gateway",
    ]));
    expect(GATEWAY_GRANTS.some((grant) => /UPDATE ON finished_work_receipts/.test(grant))).toBe(false);
  });

  test("strict hosted reconciliation rejects missing role and credentials view", async () => {
    const missingRole = Object.assign(async () => [], { unsafe: async () => [] }) as unknown as Sql;
    await expect(applyGatewayGrants(missingRole, { strict: true })).rejects.toThrow(
      "required hosted role",
    );

    let query = 0;
    const missingView = Object.assign(
      async () => (query++ === 0 ? [{ present: 1 }] : []),
      { unsafe: async () => [] },
    ) as unknown as Sql;
    await expect(applyGatewayGrants(missingView, { strict: true })).rejects.toThrow(
      "required hosted credentials view",
    );
  });

  test("a present restricted role makes every grant failure boot-fatal", async () => {
    let query = 0;
    const failingGrant = Object.assign(
      async () => (query++ === 0 ? [{ present: 1 }] : []),
      { unsafe: async () => { throw new Error("relation missing"); } },
    ) as unknown as Sql;

    await expect(applyGatewayGrants(failingGrant)).rejects.toThrow("relation missing");
  });

  test("keeps grants deployable before the one-time hosted role cutover", async () => {
    let query = 0;
    const applied: string[] = [];
    const legacyHost = Object.assign(
      async () => {
        query += 1;
        if (query === 1) return [];
        return [{ present: 1 }];
      },
      { unsafe: async (grant: string) => applied.push(grant) },
    ) as unknown as Sql;

    await applyGatewayGrants(legacyHost, { strict: true });

    expect(applied).toHaveLength(GATEWAY_GRANTS.length + 1);
    expect(applied.every((grant) => !grant.includes("useagent_gateway"))).toBe(true);
    expect(applied.every((grant) => grant.includes("skynet_gateway"))).toBe(true);
  });
});
