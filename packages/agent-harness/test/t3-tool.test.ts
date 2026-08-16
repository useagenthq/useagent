import { describe, expect, test } from "bun:test";
import { firstSemanticT3ToolName, isT3TransportToolName } from "../src/t3-tool";

describe("T3 semantic tool names", () => {
  test("rejects every known transport placeholder", () => {
    for (const placeholder of [
      "dynamic_tool_call",
      "Mcp tool call",
      "mcp_tool_call",
      "task",
      "tool",
      "unknown",
    ]) {
      expect(isT3TransportToolName(placeholder)).toBe(true);
    }
  });

  test("selects the first provider tool name instead of an envelope label", () => {
    expect(firstSemanticT3ToolName("mcp_tool_call", "github_clone_repository")).toBe(
      "github_clone_repository",
    );
    expect(firstSemanticT3ToolName("task", "  ", undefined)).toBeNull();
  });
});
