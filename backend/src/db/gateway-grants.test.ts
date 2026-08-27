import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import { applyGatewayGrants, GATEWAY_GRANTS } from "./gateway-grants";

/** Normalize a GRANT statement for comparison: collapse whitespace, drop the
 *  trailing semicolon, uppercase keywords are already literal in both sources. */
function normalize(grant: string): string {
  return grant.replace(/\s+/g, " ").replace(/;$/, "").trim();
}

/** Extract every `GRANT ... TO useagent_gateway;` from the provisioning script,
 *  joining continuation lines, excluding the credentials VIEW grant (the view
 *  is provisioning-owned; boot grants it only when present). */

describe("gateway grants single source of truth", () => {

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
