/**
 * Values already stored or deployed under the product's first name
 * (docs/architecture/legacy-identifiers.md). Code and the other tests reach
 * them through named constants; this file pins the literals, so changing one
 * fails here instead of silently stranding stored data or a live sandbox.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LEGACY_TOOL_SERVER_IDS, PLATFORM_EVENT_LANES } from "@useagent/agent-harness/canonical";
import { DAYTONA_SNAPSHOT_DEFAULTS } from "@useagent/sandbox-daytona";
import { LEGACY_GATEWAY_DATABASE_ROLE } from "../src/db/gateway-grants";
import { DEV_ORG_ID } from "../src/dev-org";
import { isRuntimePlaneMessageId, runtimeThreadId, runtimeUserMessageId } from "../src/engines/runtime-orchestration";
import { APPROVAL_CAPABILITY_DERIVE_LABEL } from "../src/knowledge/gateway/approval-capability";
import { TOOL_TOKEN_DERIVE_LABEL } from "../src/knowledge/gateway/token";
import { EXPLICIT_MEMORY_TAG } from "../src/memory/explicit-memory";
import { EXPLICIT_MEMORY_SESSION } from "../src/memory/team-memory";
import { CLAUDE_CONFIG_DIR } from "../src/provider-gateway/sandbox-config";
import { PROVIDER_TOKEN_DERIVE_LABEL } from "../src/provider-gateway/token";
import { LEGACY_WARM_POOL_TEMPLATE_LABEL } from "../src/sandboxes/cube-warm-pool-reconcile";
import { LEGACY_SANDBOX_GENERATION_LABEL, LEGACY_SANDBOX_RUN_LABEL } from "../src/sandboxes/label-compat";
import { SANDBOX_NAME_PREFIX, SANDBOX_STATE_DIR, SANDBOX_STATE_HOME } from "../src/sandboxes/sandbox-names";
import { ORG_SECRETS_HKDF_INFO } from "../src/secrets/crypto";
import { SECRET_DOTENV_PATH } from "../src/secrets/inject";
import { DEFAULT_DEV_AUTH_SECRET } from "../src/security/runtime-secrets";

describe("persisted names stay frozen", () => {
  test("names inside retained sandboxes and baked images", () => {
    expect(SANDBOX_NAME_PREFIX).toBe("skynet");
    expect(SANDBOX_STATE_DIR).toBe(".skynet");
    expect(SANDBOX_STATE_HOME).toBe("$HOME/.skynet");
    expect(CLAUDE_CONFIG_DIR).toBe("/tmp/skynet-claude-config");
    expect(SECRET_DOTENV_PATH.endsWith("/skynet-env.sh")).toBe(true);
    expect(runtimeThreadId({ threadId: "thread-1", runId: "run-1" })).toBe("skynet-thread-thread-1");
    expect(runtimeUserMessageId("run-1")).toBe("skynet-message-run-1");
    expect(isRuntimePlaneMessageId("skynet-message-run-1")).toBe(true);
  });

  test("event lanes and tool server ids in stored events", () => {
    expect(PLATFORM_EVENT_LANES).toEqual({
      platform: "skynet",
      memory: "skynet-memory",
      gateway: "skynet-gateway",
      timing: "skynet-timing",
      knowledge: "skynet-knowledge",
    });
    expect(LEGACY_TOOL_SERVER_IDS).toEqual({ gateway: "skynet-knowledge", browser: "skynet-browser" });
  });

  test("stored identities, labels, roles and key labels", () => {
    expect(DEV_ORG_ID).toBe("org-skynet-dev");
    expect(LEGACY_GATEWAY_DATABASE_ROLE).toBe("skynet_gateway");
    expect(LEGACY_SANDBOX_RUN_LABEL).toBe("skynet-run");
    expect(LEGACY_SANDBOX_GENERATION_LABEL).toBe("skynet-provider-generation");
    expect(LEGACY_WARM_POOL_TEMPLATE_LABEL).toBe("skynet-warm-pool-template");
    expect(EXPLICIT_MEMORY_TAG).toBe("[skynet-explicit-memory]");
    expect(EXPLICIT_MEMORY_SESSION).toBe("skynet-explicit-memory");
    expect(APPROVAL_CAPABILITY_DERIVE_LABEL).toBe("skynet-gateway-operation-approval-v1");
    expect(TOOL_TOKEN_DERIVE_LABEL).toBe("skynet-tool-gateway-v1");
    expect(PROVIDER_TOKEN_DERIVE_LABEL).toBe("skynet-provider-gateway-v1");
    expect(ORG_SECRETS_HKDF_INFO).toBe("skynet-org-secrets-v1");
    expect(DEFAULT_DEV_AUTH_SECRET).toBe("dev-skynet-secret-change-me");
    expect(DAYTONA_SNAPSHOT_DEFAULTS.DAYTONA_SNAPSHOT).toBe("skynet-agent-v17");
  });

  test("the memory gateway instance and its data volume", () => {
    const memory = (file: string) => readFileSync(new URL(`../../memory/${file}`, import.meta.url), "utf8");
    expect(memory("tdai-gateway.yaml")).toMatch(/^instanceId: skynet$/m);
    expect(memory("docker-compose.yml")).toContain("- skynet-memory-core-data:/data/tdai-memory");
  });
});
