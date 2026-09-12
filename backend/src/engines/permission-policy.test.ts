// P0 fail-closed permission policy. Tests the ACTUAL decision
// payloads and the ACTUAL claude CLI argument string - not just the env helper -
// and proves the dev-mode gate holds in production.

import { afterEach, describe, expect, test } from "bun:test";
import { allowPermissionBypass } from "./permission-bypass";
import { answerAcpPermissionRequest, decideAcpPermission } from "./permission-policy";
import { claudeSpec } from "./sandbox";

const ALLOW_ONCE = { optionId: "opt-once", kind: "allow_once" };
const ALLOW_ALWAYS = { optionId: "opt-always", kind: "allow_always" };

const origNode = process.env.NODE_ENV;
const origDev = process.env.USEAGENT_DEV_MODE;
const origYolo = process.env.ACP_YOLO_APPROVE;
const restore = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
afterEach(() => {
  restore("NODE_ENV", origNode);
  restore("USEAGENT_DEV_MODE", origDev);
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
        "mcp.useagent.computer_screenshot",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE, ALLOW_ALWAYS],
        false,
        "mcp.useagent.computer_sequence",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE, ALLOW_ALWAYS],
        false,
        "mcp.useagent.desktop_recording_start",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE],
        false,
        "mcp.useagent.desktop_recording_stop",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE],
        false,
        "mcp.useagent.github_repositories",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE],
        false,
        "mcp.useagent.github_clone_repository",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.useagent.skills_list"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.useagent.skill_activate"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.useagent.automation_create"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.useagent.automation_delete"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission(
        [ALLOW_ALWAYS],
        false,
        "mcp.useagent.memory_search",
      ),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.useagent.computer_future"),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.useagent.memory_delete_all"),
    ).toEqual({ outcome: { outcome: "cancelled" } });
    expect(
      decideAcpPermission(
        [ALLOW_ONCE],
        false,
        "mcp.skynet-knowledge.artifact_publish",
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.useagent.web_search"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.useagent.gcs_list_buckets"),
    ).toEqual({ outcome: { outcome: "selected", optionId: "opt-once" } });
    expect(
      decideAcpPermission([ALLOW_ONCE], false, "mcp.useagent.gcs_delete_bucket"),
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
        "mcp__useagent__gcs_list_buckets",
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

  test("accepts Claude's semantic execute kind without trusting arbitrary titles", () => {
    expect(decideAcpPermission([ALLOW_ONCE], false, "Execute", "execute")).toEqual({
      outcome: { outcome: "selected", optionId: "opt-once" },
    });
    expect(decideAcpPermission([ALLOW_ONCE], false, "Run command", "execute")).toEqual({
      outcome: { outcome: "selected", optionId: "opt-once" },
    });
    expect(decideAcpPermission([ALLOW_ONCE], false, "Execute", "other")).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(decideAcpPermission([ALLOW_ONCE], false, "Execute")).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(decideAcpPermission([ALLOW_ALWAYS], false, "Execute", "execute")).toEqual({
      outcome: { outcome: "cancelled" },
    });
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
    delete process.env.USEAGENT_DEV_MODE;
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
    const command = claudeSpec.command({ model: "claude-opus-5", resumeId: undefined });
    expect(command).not.toContain("--dangerously-skip-permissions");
    expect(command).toContain("--settings /tmp/useagent-claude-capability/useagent-settings.json");
    expect(command).toContain("--mcp-config /tmp/useagent-claude-capability/useagent-mcp.json");
  });

  test("production NEVER carries the skip flag, even with the yolo env set", () => {
    process.env.NODE_ENV = "production";
    delete process.env.USEAGENT_DEV_MODE;
    process.env.ACP_YOLO_APPROVE = "1";
    expect(claudeSpec.command({ model: "claude-opus-5", resumeId: undefined })).not.toContain("--dangerously-skip-permissions");
  });

  test("dev-yolo opt-in carries the skip flag (explicit, verified-dev only)", () => {
    process.env.NODE_ENV = "development";
    process.env.ACP_YOLO_APPROVE = "1";
    expect(claudeSpec.command({ model: "claude-opus-5", resumeId: undefined })).toContain("--dangerously-skip-permissions");
  });
});

// Recorded from codex-acp 1.1.14 (@openai/codex 0.147.0) on skynet-acp-v3, run
// 2c4e6e17 of the 2026-09-02 audit fix: the apply_patch approval and the shell
// escalation that followed the failed nested sandbox. Option ids and kinds are
// exactly what codex-acp's CodexApprovalHandler sends; ids start at 0.
const RECORDED_EDIT_REQUEST = {
  jsonrpc: "2.0",
  id: 0,
  method: "session/request_permission",
  params: {
    sessionId: "01a062dd-3453-7582-b698-eb09b143fdd7",
    toolCall: { toolCallId: "exec-56b5a70f-3bea-422c-ada6-f61cd0966090", kind: "edit", status: "pending" },
    options: [
      { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
      { optionId: "allow_always", name: "Allow for Session", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  },
} as const;
const RECORDED_EXECUTE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "session/request_permission",
  params: {
    sessionId: "01a062dd-3453-7582-b698-eb09b143fdd7",
    toolCall: {
      toolCallId: "exec-c0ae5917-7ac7-4933-ad62-52dd985f4748",
      kind: "execute",
      status: "pending",
      rawInput: { command: "cat hello.txt", cwd: "/home/daytona/work" },
    },
    options: [
      { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
      { optionId: "allow_always", name: "Allow for Session", kind: "allow_always" },
      { optionId: "accept_execpolicy_amendment", name: "Allow Commands Starting With `cat`", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  },
} as const;
// The tool_call update codex-acp had emitted for the same shell command: presented
// as a file read, even though the escalation it then asks for is an execute.
const RECORDED_CAT_TOOL_CALL = { kind: "read", title: "Read file '/home/daytona/work/hello.txt'" };

describe("answerAcpPermissionRequest - the JSON-RPC answer to recorded codex-acp requests", () => {
  test("fail closed: a file edit is cancelled, the answer keeps the request id (0 included)", () => {
    expect(answerAcpPermissionRequest(RECORDED_EDIT_REQUEST, { kind: "edit", title: "Editing files" }, false)).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: { outcome: { outcome: "cancelled" } },
    });
  });

  test("a shell escalation is allowed once by its own execute kind, not the recorded read kind", () => {
    expect(answerAcpPermissionRequest(RECORDED_EXECUTE_REQUEST, RECORDED_CAT_TOOL_CALL, false)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
    // Same answer when the tool_call update has not been recorded yet.
    expect(answerAcpPermissionRequest(RECORDED_EXECUTE_REQUEST, undefined, false).result).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
  });

  test("dev auto-approve selects allow_once for the edit as well", () => {
    expect(answerAcpPermissionRequest(RECORDED_EDIT_REQUEST, undefined, true).result).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
  });

  test("a request without a kind falls back to the recorded tool_call kind and title", () => {
    const request = { id: 2, params: { options: [{ optionId: "allow_once", kind: "allow_once" }] } };
    expect(answerAcpPermissionRequest(request, { kind: "execute" }, false).result).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(answerAcpPermissionRequest(request, { kind: "other", title: "mcp.skynet-knowledge.web_search" }, false).result).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(answerAcpPermissionRequest(request, undefined, false).result).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  test("the production gate holds: ACP_YOLO_APPROVE cannot approve an edit outside dev mode", () => {
    process.env.NODE_ENV = "production";
    delete process.env.USEAGENT_DEV_MODE;
    process.env.ACP_YOLO_APPROVE = "1";
    expect(answerAcpPermissionRequest(RECORDED_EDIT_REQUEST, undefined).result).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });
});
