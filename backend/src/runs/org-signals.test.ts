import { describe, expect, test } from "bun:test";
import { decodeOrgChange } from "@useagent/agent-client/org-changes";
import { clientOrgChangeForUser, type OrgChange } from "./org-signals";

const internalChange = {
  type: "provider_connection",
  action: "updated",
  targetUserId: "user-1",
  connectionId: "connection-1",
  provider: "openai",
  authMethod: "chatgpt_oauth",
  status: "connected",
} satisfies OrgChange;

describe("provider connection org-change projection", () => {
  test("publishes the canonical browser-safe change only to the target user", () => {
    const projected = clientOrgChangeForUser(internalChange, "user-1");

    expect(projected).toEqual({
      type: "provider_connection",
      action: "updated",
      provider: "openai",
      authMethod: "chatgpt_oauth",
    });
    expect(decodeOrgChange(projected)).toEqual(projected);
    expect(clientOrgChangeForUser(internalChange, "user-2")).toBeNull();
    expect(clientOrgChangeForUser(internalChange, null)).toBeNull();
  });

  test("preserves the revoked action without exposing internal fields", () => {
    const projected = clientOrgChangeForUser(
      { ...internalChange, action: "revoked", status: "revoked" },
      "user-1",
    );

    expect(projected).toEqual({
      type: "provider_connection",
      action: "revoked",
      provider: "openai",
      authMethod: "chatgpt_oauth",
    });
    expect(JSON.stringify(projected)).not.toContain("connectionId");
    expect(JSON.stringify(projected)).not.toContain("targetUserId");
    expect(JSON.stringify(projected)).not.toContain("status");
  });
});

describe("integration connection org-change projection", () => {
  const userOwned = {
    type: "integration_connection",
    action: "health_changed",
    targetUserId: "user-1",
    connectionId: "integration-1",
    provider: "linear",
  } satisfies OrgChange;

  test("publishes user-owned changes only to the target user", () => {
    const projected = clientOrgChangeForUser(userOwned, "user-1");

    expect(projected).toEqual({
      type: "integration_connection",
      action: "health_changed",
      connectionId: "integration-1",
      provider: "linear",
    });
    expect(decodeOrgChange(projected)).toEqual(projected);
    expect(clientOrgChangeForUser(userOwned, "user-2")).toBeNull();
    expect(clientOrgChangeForUser(userOwned, null)).toBeNull();
    expect(JSON.stringify(projected)).not.toContain("targetUserId");
  });

  test("publishes org-owned changes to authenticated org members", () => {
    const orgOwned: OrgChange = {
      type: "integration_connection",
      action: "updated",
      connectionId: "integration-org",
      provider: "notion",
    };

    expect(clientOrgChangeForUser(orgOwned, "user-1")).toEqual(orgOwned);
    expect(clientOrgChangeForUser(orgOwned, null)).toEqual(orgOwned);
  });
});
