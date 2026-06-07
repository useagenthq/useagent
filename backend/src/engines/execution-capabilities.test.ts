import { describe, expect, test } from "bun:test";
import {
  buildExecutionCapabilitySnapshot,
  executionCapabilityPrompt,
  unsupportedExecutionCapabilitySnapshot,
} from "./execution-capabilities";
import { advertisedGatewayToolDescriptors } from "../knowledge/gateway/operation-registry";

describe("execution capability snapshot", () => {
  test("advertises lazy desktop control and dynamic tools through direct gateway discovery", () => {
    const snapshot = buildExecutionCapabilitySnapshot({
      runtime: "sandbox",
      workspaceRoot: "/root/work",
      gatewayAvailable: true,
      desktopAvailability: "on_demand",
    }, { GATEWAY_COMPACT_TOOLS: "0" });

    expect(snapshot.facilities.desktop).toEqual({
      availability: "on_demand",
      access: {
        kind: "useagent_gateway",
        discovery: "direct",
        operations: ["computer_screenshot", "computer_sequence"],
      },
    });
    expect(snapshot.facilities.tools).toEqual({
      availability: "ready",
      access: { kind: "useagent_gateway", discovery: "direct", operations: [] },
    });
    expect(snapshot.facilities.shell).toEqual({
      availability: "ready",
      access: { kind: "native" },
    });
    const registered = new Set(
      advertisedGatewayToolDescriptors({ childSessions: true, slack: true })
        .map((tool) => tool.name),
    );
    for (const operation of ["computer_screenshot", "computer_sequence"]) {
      expect(registered.has(operation)).toBe(true);
    }
  });

  test("names the complete compact discovery route for desktop and future tools", () => {
    const snapshot = buildExecutionCapabilitySnapshot({
      runtime: "sandbox",
      gatewayAvailable: true,
      desktopAvailability: "on_demand",
    }, { GATEWAY_COMPACT_TOOLS: "1" });

    expect(snapshot.facilities.tools.access).toEqual({
      kind: "useagent_gateway",
      discovery: "compact",
      search: "gateway_tools_search",
      describe: "gateway_tool_describe",
      call: "gateway_tool_call",
      operations: [],
    });
    expect(snapshot.facilities.browser.access).toMatchObject({
      discovery: "compact",
      operations: ["computer_screenshot", "computer_sequence"],
    });
  });

  test("fails closed when no gateway or runtime facility is proven", () => {
    const snapshot = unsupportedExecutionCapabilitySnapshot("managed");
    for (const facility of Object.values(snapshot.facilities)) {
      expect(facility).toEqual({ availability: "unsupported", access: { kind: "none" } });
    }
  });

  test("prompt is bounded, authoritative, and tells agents to discover before denying", () => {
    const snapshot = buildExecutionCapabilitySnapshot({
      runtime: "sandbox",
      gatewayAvailable: true,
      desktopAvailability: "on_demand",
    }, { GATEWAY_COMPACT_TOOLS: "1" });
    const prompt = executionCapabilityPrompt(snapshot);
    expect(prompt.length).toBeLessThan(2_000);
    expect(prompt).toContain("authoritative and supersedes earlier snapshots");
    expect(prompt).toContain("Before declaring any installed tool or integration unavailable");
    expect(prompt).toContain('"desktop":{"availability":"on_demand"');
    expect(prompt).toContain("gateway_tools_search");
  });
});
