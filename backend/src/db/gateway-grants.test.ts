import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { GATEWAY_GRANTS } from "./gateway-grants";

/** Normalize a GRANT statement for comparison: collapse whitespace, drop the
 *  trailing semicolon, uppercase keywords are already literal in both sources. */
function normalize(grant: string): string {
  return grant.replace(/\s+/g, " ").replace(/;$/, "").trim();
}

/** Extract every `GRANT ... TO skynet_gateway;` from the provisioning script,
 *  joining continuation lines, excluding the credentials VIEW grant (the view
 *  is provisioning-owned; boot grants it only when present). */
function scriptGrants(script: string): string[] {
  const out: string[] = [];
  // Multiline-tolerant: a GRANT may wrap its table list across lines; consume
  // up to the first semicolon and normalize whitespace afterward.
  for (const match of script.matchAll(/^GRANT [\s\S]*?TO skynet_gateway;/gm)) {
    const grant = normalize(match[0]);
    if (grant.includes("gateway_provider_api_key_credentials")) continue;
    // Structural role baseline (database CONNECT, schema USAGE) is
    // provisioning-owned, not part of the per-table manifest.
    if (grant.startsWith("GRANT CONNECT ") || grant.startsWith("GRANT USAGE ")) continue;
    out.push(grant);
  }
  return out.sort();
}

describe("gateway grants single source of truth", () => {
  test("the boot manifest and configure-host.sh state the same grants", async () => {
    const script = await readFile(
      new URL("../../../deploy/hetzner/configure-host.sh", import.meta.url),
      "utf8",
    );
    const fromScript = scriptGrants(script);
    const fromManifest = GATEWAY_GRANTS.map(normalize).sort();
    // Drift in EITHER direction fails: a grant added to the script must land in
    // the boot manifest (or deploys will not reconcile it), and a manifest
    // grant must be mirrored in provisioning for fresh hosts.
    expect(fromManifest).toEqual(fromScript);
  });

  test("least privilege holds: no DELETE, no ALL, no provider_connections table grant", () => {
    for (const grant of GATEWAY_GRANTS) {
      expect(grant).not.toMatch(/\bDELETE\b/);
      expect(grant).not.toMatch(/\bALL\b/);
      expect(grant).not.toMatch(/ON provider_connections\b/);
    }
  });
});
