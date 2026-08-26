import { describe, expect, test } from "bun:test";
import {
  firstSemanticT3ToolName,
  isT3TransportToolName,
  t3SummaryToolIdentity,
  t3TaskDisplayTitle,
} from "../src/t3-tool";

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

  test("recovers a semantic server and tool from T3 summary-only wrappers", () => {
    expect(t3SummaryToolIdentity("skynet-knowledge_github_clone_repository")).toEqual({
      server: "skynet-knowledge",
      tool: "github_clone_repository",
    });
    expect(t3SummaryToolIdentity("skynet-knowledge · computer_screenshot started")).toEqual({
      server: "skynet-knowledge",
      tool: "computer_screenshot",
    });
    expect(t3SummaryToolIdentity("Mcp tool call")).toBeNull();
  });

  test("names child tasks from provider metadata instead of transport placeholders", () => {
    expect(t3TaskDisplayTitle({
      title: "Tool",
      summary: "Tool started",
      taskId: "google_price",
    })).toBe("google price");
    expect(t3TaskDisplayTitle({
      title: "Price researcher",
      role: "researcher",
      taskId: "task_1",
    })).toBe("Price researcher");
  });
});
