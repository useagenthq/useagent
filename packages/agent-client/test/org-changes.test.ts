import { describe, expect, test } from "bun:test";
import { decodeOrgChange, type OrgChange, type RunChangeAction } from "../src/org-changes";

describe("org-change wire contract", () => {
  test("decodes every browser-visible event variant", () => {
    const runActions = ["created", "running", "settled", "cancelled"] satisfies RunChangeAction[];
    for (const action of runActions) {
      const change = {
        type: "run",
        action,
        runId: "run-1",
        threadId: "thread-1",
      } satisfies OrgChange;
      expect(decodeOrgChange(change)).toEqual(change);
    }

    const changes = [
      {
        type: "artifact",
        action: "created",
        artifactId: "artifact-1",
        runId: "run-1",
        threadId: "thread-1",
      },
      {
        type: "artifact",
        action: "updated",
        artifactId: "artifact-1",
        runId: "run-1",
        threadId: "thread-1",
      },
      { type: "automation", action: "created", automationId: "automation-1" },
      { type: "automation", action: "updated", automationId: "automation-1" },
      { type: "automation", action: "deleted", automationId: "automation-1" },
      {
        type: "automation",
        action: "fired",
        automationId: "automation-1",
        runId: "run-1",
      },
      {
        type: "provider_connection",
        action: "updated",
        provider: "anthropic",
        authMethod: "api_key",
      },
      {
        type: "provider_connection",
        action: "revoked",
        provider: "openai",
        authMethod: "chatgpt_oauth",
      },
      {
        type: "integration_connection",
        action: "created",
        connectionId: "connection-1",
        provider: "linear",
      },
      {
        type: "integration_connection",
        action: "health_changed",
        connectionId: "connection-1",
        provider: "linear",
        targetUserId: "user-1",
      },
    ] satisfies OrgChange[];

    for (const change of changes) expect(decodeOrgChange(change)).toEqual(change);
  });

  test("rejects incomplete and unknown events", () => {
    expect(decodeOrgChange(null)).toBeNull();
    expect(
      decodeOrgChange({ type: "run", action: "deleted", runId: "run-1", threadId: "thread-1" }),
    ).toBeNull();
    expect(
      decodeOrgChange({
        type: "artifact",
        action: "updated",
        runId: "run-1",
        threadId: "thread-1",
      }),
    ).toBeNull();
    expect(
      decodeOrgChange({ type: "automation", action: "fired", automationId: "automation-1" }),
    ).toBeNull();
    expect(
      decodeOrgChange({
        type: "provider_connection",
        action: "created",
        provider: "openai",
        authMethod: "chatgpt_oauth",
      }),
    ).toBeNull();
    expect(
      decodeOrgChange({
        type: "integration_connection",
        action: "updated",
        provider: "linear",
      }),
    ).toBeNull();
  });

  test("returns the canonical fields without carrying unknown wire data", () => {
    const decoded = decodeOrgChange({
      type: "artifact",
      action: "updated",
      artifactId: "artifact-1",
      runId: "run-1",
      threadId: "thread-1",
      secret: "must-not-cross",
    });

    expect(decoded).toEqual({
      type: "artifact",
      action: "updated",
      artifactId: "artifact-1",
      runId: "run-1",
      threadId: "thread-1",
    });
  });
});
