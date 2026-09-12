import { describe, expect, test } from "bun:test";
import type { CapabilityCatalog } from "@/lib/capability-catalog";
import { gatewayServerFromCapabilityCatalog } from "./settings-tools-data";

const CATALOG = {
  version: 1,
  scope: "pre_run",
  engines: [],
  tools: {
    gatewayConfigured: true,
    declared: [
      {
        name: "knowledge_search",
        category: "knowledge",
        aliases: [],
        declared: true,
        configured: true,
        currentRunAvailable: null,
        approval: "none",
        effect: "not_declared",
      },
      {
        name: "slack_send",
        category: "slack",
        aliases: [],
        declared: true,
        configured: false,
        currentRunAvailable: null,
        approval: "none",
        effect: "not_declared",
      },
    ],
  },
  nativeSlashCommands: { catalog: "session_runtime", currentRun: null },
} satisfies CapabilityCatalog;

describe("settings tools catalog", () => {
  test("shows only endpoint-configured tools and does not claim current-run availability", () => {
    expect(gatewayServerFromCapabilityCatalog(CATALOG, true)).toMatchObject({
      status: "connected",
      summary: "1 tools configured; live-run availability is resolved per session",
      tools: ["knowledge_search"],
    });
  });

  test("reports loading and unconfigured states without placeholder servers", () => {
    expect(gatewayServerFromCapabilityCatalog(null, false).summary).toBe(
      "Loading capability catalog",
    );
    expect(gatewayServerFromCapabilityCatalog(null, true)).toMatchObject({
      status: "error",
      summary: "Tool gateway is not configured",
      tools: [],
    });
  });
});
