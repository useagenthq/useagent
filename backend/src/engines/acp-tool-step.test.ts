import { describe, expect, test } from "bun:test";
import { buildAcpToolStep } from "./acp-tool-step";

const native = {
  sessionID: "ses_1",
  messageID: "msg_tool_1",
  partID: "part_tool_1",
  callID: "call_1",
} as const;

describe("buildAcpToolStep", () => {
  test("stamps stable native ids so the canonical timeline can order the tool", () => {
    const step = buildAcpToolStep(
      { kind: "execute", title: "Run", rawInput: { command: "pwd" } },
      undefined,
      native,
    );

    expect(step.code_json).toEqual({
      tool: "execute",
      title: "Run",
      input: { command: "pwd" },
      native,
    });
  });

  test("preserves native ids and marks a failed completion", () => {
    const step = buildAcpToolStep(
      { kind: "execute", title: "Run", rawInput: { command: "false" } },
      "exit 1",
      native,
      true,
    );

    expect(step.code_json).toMatchObject({ native, error: true, output: "exit 1" });
  });

  test("preserves an MCP method name when ACP classifies it as other", () => {
    const step = buildAcpToolStep(
      {
        kind: "other",
        title: "mcp__skynet-browser__browser_navigate",
        rawInput: { url: "https://example.com" },
      },
      "navigated",
      native,
    );

    expect(step.code_json).toMatchObject({
      tool: "mcp__skynet-browser__browser_navigate",
      title: "mcp__skynet-browser__browser_navigate",
    });
    expect(step.chip).toBe("mcp");
  });
});
