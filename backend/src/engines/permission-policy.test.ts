// P0 fail-closed permission policy. Tests the ACTUAL decision
// payloads and the ACTUAL claude CLI argument string - not just the env helper -
// and proves the dev-mode gate holds in production.

import { afterEach, describe, expect, test } from "bun:test";
import { allowPermissionBypass } from "./permission-bypass";
import { decideAcpPermission } from "./permission-policy";
import { claudeSpec } from "./sandbox";

const ALLOW_ONCE = { optionId: "opt-once", kind: "allow_once" };
const ALLOW_ALWAYS = { optionId: "opt-always", kind: "allow_always" };

const origNode = process.env.NODE_ENV;
const origDev = process.env.SKYNET_DEV_MODE;
const origYolo = process.env.ACP_YOLO_APPROVE;
const restore = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
afterEach(() => {
  restore("NODE_ENV", origNode);
  restore("SKYNET_DEV_MODE", origDev);
  restore("ACP_YOLO_APPROVE", origYolo);
});

describe("decideAcpPermission - actual response payloads (pure logic)", () => {
  test("fail closed: deny (cancelled) when not auto-approving", () => {
    expect(decideAcpPermission([ALLOW_ONCE, ALLOW_ALWAYS], false)).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  test("auto-approve prefers allow_once, then allow_always, then first", () => {
    expect(decideAcpPermission([ALLOW_ALWAYS, ALLOW_ONCE], true)).toEqual({
      outcome: { outcome: "selected", optionId: "opt-once" },
    });
    expect(decideAcpPermission([ALLOW_ALWAYS], true)).toEqual({
      outcome: { outcome: "selected", optionId: "opt-always" },
    });
    expect(decideAcpPermission([{ optionId: "x", kind: "other" }], true)).toEqual({
      outcome: { outcome: "selected", optionId: "x" },
    });
  });

  test("auto-approve with no usable option still denies", () => {
    expect(decideAcpPermission([], true)).toEqual({ outcome: { outcome: "cancelled" } });
    expect(decideAcpPermission([{ kind: "allow_once" }], true)).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  test("production auto-approves only trusted active-run gateway tools", () => {
    expect(
      decideAcpPermission(
        [ALLOW_ONCE, ALLOW_ALWAYS],
        false,
        "mcp.skynet-knowledge.computer_screenshot",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE, ALLOW_ALWAYS],
        false,
        "mcp.skynet-knowledge.computer_sequence",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE, ALLOW_ALWAYS],
        false,
        "mcp.skynet-knowledge.desktop_recording_start",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE],
        false,
        "mcp.skynet-knowledge.desktop_recording_stop",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE],
        false,
        "mcp.skynet-knowledge.github_repositories",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE],
        false,
        "mcp.skynet-knowledge.github_clone_repository",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.skynet-knowledge.loop_login_open"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.skynet-knowledge.loop_login_destroy"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.skynet-knowledge.skills_list"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.skynet-knowledge.skill_activate"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.skynet-knowledge.automation_create"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.skynet-knowledge.automation_delete"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission(
        [ALLOW_ALWAYS],
        false,
        "mcp.skynet-knowledge.loop_login_destroy",
      ),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.skynet-knowledge.computer_future"),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.skynet-knowledge.loop_login_delete_all"),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE],
        false,
        "mcp.skynet-knowledge.artifact_publish",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.skynet-knowledge.web_search"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.skynet-knowledge.gcs_list_buckets"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.skynet-knowledge.gcs_delete_bucket"),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE],
        false,
        "mcp.skynet-browser.browser_navigate",
      ),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE],
        false,
        "mcp.attacker-skynet-browser.browser_navigate",
      ),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(decideAcpPermission([ALLOW_ONCE], false, "shell")).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  test("accepts Claude ACP names for registered gateway and sandbox-native tools", () => {
    expect(
      decideAcpPermission(
        [ALLOW_ONCE],
        false,
        "mcp__skynet-knowledge__gcs_list_buckets",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp__skynet-knowledge__memory_remember"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    for (const title of ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "Task"]) {
      expect(decideAcpPermission([ALLOW_ONCE], false, title)).toEqual({
        outcome: { outcome: "selected", optionId: "opt-once" },
      });
    }
  });

  test("rejects unregistered gateway lookalikes and unsafe native tools", () => {
    for (const title of [
      "mcp__skynet-knowledge__gcs_delete_bucket",
      "mcp__attacker-skynet-knowledge__gcs_list_buckets",
      "mcp__skynet-knowledge__computer_future",
      "WebFetch",
      "WebSearch",
      "shell",
    ]) {
      expect(decideAcpPermission([ALLOW_ONCE], false, title)).toEqual({
        outcome: { outcome: "cancelled" },
      });
    }
  });
});

describe("dev-mode gate holds (env-derived default)", () => {
  test("production DENIES even with ACP_YOLO_APPROVE=1", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SKYNET_DEV_MODE;
    process.env.ACP_YOLO_APPROVE = "1";
    // decideAcpPermission()/allowPermissionBypass() read the env-gated acpAutoApprove
    expect(decideAcpPermission([ALLOW_ONCE])).toEqual({ outcome: { outcome: "cancelled" } });
    expect(allowPermissionBypass()).toBe(false);
  });

  test("dev + ACP_YOLO_APPROVE=1 approves", () => {
    process.env.NODE_ENV = "development";
    process.env.ACP_YOLO_APPROVE = "1";
    expect(decideAcpPermission([ALLOW_ONCE])).toEqual({
      outcome: { outcome: "selected", optionId: "opt-once" },
    });
    expect(allowPermissionBypass()).toBe(true);
  });

  test("dev without the flag still denies (fail closed default)", () => {
    process.env.NODE_ENV = "development";
    delete process.env.ACP_YOLO_APPROVE;
    expect(decideAcpPermission([ALLOW_ONCE])).toEqual({ outcome: { outcome: "cancelled" } });
    expect(allowPermissionBypass()).toBe(false);
  });
});

describe("actual claude CLI arguments", () => {
  test("no --dangerously-skip-permissions by default (dev, no yolo)", () => {
    process.env.NODE_ENV = "development";
    delete process.env.ACP_YOLO_APPROVE;
    expect(claudeSpec.command({ model: "claude-opus-5", resumeId: undefined })).not.toContain("--dangerously-skip-permissions");
  });

  test("production NEVER carries the skip flag, even with the yolo env set", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SKYNET_DEV_MODE;
    process.env.ACP_YOLO_APPROVE = "1";
    expect(claudeSpec.command({ model: "claude-opus-5", resumeId: undefined })).not.toContain("--dangerously-skip-permissions");
  });

  test("dev-yolo opt-in carries the skip flag (explicit, verified-dev only)", () => {
    process.env.NODE_ENV = "development";
    process.env.ACP_YOLO_APPROVE = "1";
    expect(claudeSpec.command({ model: "claude-opus-5", resumeId: undefined })).toContain("--dangerously-skip-permissions");
  });
});
