import { describe, expect, test } from "bun:test";
import { decodeOrgChange } from "@skynet/agent-client/org-changes";
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
