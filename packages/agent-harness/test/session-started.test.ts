import { describe, expect, test } from "bun:test";
import {
  SESSION_STARTED_EVENT_TYPE,
  normalizeExecutionCapabilitySnapshot,
  normalizeNegotiatedCapabilities,
  parseSessionStartedFrame,
} from "../src/canonical";
import { translateOpenCode, type OpenCodeFrame } from "../src/opencode-canonical";

const CTX = { runId: "r", threadId: "t", engine: "engine" };
const nativeFacility = { availability: "ready", access: { kind: "native" } } as const;
const unsupportedFacility = {
  availability: "unsupported",
  access: { kind: "none" },
} as const;

function executionCapabilities() {
  return {
    version: 1,
    runtime: "sandbox",
    workspaceRoot: "/workspace",
    facilities: {
      files: nativeFacility,
      shell: nativeFacility,
      terminal: {
        availability: "on_demand",
        access: {
          kind: "useagent_gateway",
          discovery: "direct",
          operations: ["terminal.open", "terminal.open"],
        },
      },
      desktop: {
        availability: "degraded",
        access: { kind: "user_surface_only" },
        reasonCode: "desktop_waking",
      },
      browser: {
        availability: "ready",
        access: {
          kind: "useagent_gateway",
          discovery: "compact",
          search: "gateway_tools_search",
          describe: "gateway_tool_describe",
          call: "gateway_tool_call",
          operations: ["browser.open"],
        },
      },
      tools: {
        availability: "ready",
        access: {
          kind: "useagent_gateway",
          discovery: "compact",
          search: "gateway_tools_search",
          describe: "gateway_tool_describe",
          call: "gateway_tool_call",
          operations: [],
        },
      },
    },
  };
}

function frame(over: {
  sessionId: string;
  capabilities: unknown;
  executionCapabilities?: unknown;
}): OpenCodeFrame {
  return {
    eventId: `${over.sessionId}:session`,
    seq: 0,
    provider: "engine",
    eventType: SESSION_STARTED_EVENT_TYPE,
    native: {
      sessionId: over.sessionId,
      parentSessionId: null,
      messageId: null,
      partId: null,
      callId: null,
    },
    payload: {
      source: "engine",
      capabilities: over.capabilities,
      ...(over.executionCapabilities === undefined
        ? {}
        : { executionCapabilities: over.executionCapabilities }),
    },
  };
}

describe("normalizeNegotiatedCapabilities", () => {
  test("keeps known booleans, defaults missing/non-bool keys false, and drops unknown keys", () => {
    const caps = normalizeNegotiatedCapabilities({
      commands: true,
      desktop: true,
      nativeEmbed: "yes",
      bogus: true,
    });
    expect(caps.commands).toBe(true);
    expect(caps.desktop).toBe(true);
    expect(caps.nativeEmbed).toBe(false);
    expect(caps.stop).toBe(false);
    expect((caps as unknown as Record<string, unknown>).bogus).toBeUndefined();
  });
});

describe("normalizeExecutionCapabilitySnapshot", () => {
  test("normalizes every facility and preserves dynamic gateway tool discovery", () => {
    const snapshot = normalizeExecutionCapabilitySnapshot(executionCapabilities());
    expect(snapshot?.version).toBe(1);
    expect(snapshot?.runtime).toBe("sandbox");
    expect(snapshot?.workspaceRoot).toBe("/workspace");
    expect(snapshot?.facilities.files).toEqual(nativeFacility);
    expect(snapshot?.facilities.terminal).toEqual({
      availability: "on_demand",
      access: {
        kind: "useagent_gateway",
        discovery: "direct",
        operations: ["terminal.open"],
      },
    });
    expect(snapshot?.facilities.tools.access).toEqual({
      kind: "useagent_gateway",
      discovery: "compact",
      search: "gateway_tools_search",
      describe: "gateway_tool_describe",
      call: "gateway_tool_call",
      operations: [],
    });
  });

  test("fails malformed fields closed, bounds lists, and drops unknown keys", () => {
    const operations = Array.from({ length: 80 }, (_, index) => `tool.${index}`);
    const snapshot = normalizeExecutionCapabilitySnapshot({
      version: 1,
      runtime: "managed",
      workspaceRoot: " /workspace ",
      facilities: {
        files: {
          availability: "maybe",
          access: { kind: "future_access" },
          reasonCode: " unavailable ",
          extra: true,
        },
        tools: {
          availability: "ready",
          access: { kind: "useagent_gateway", discovery: "direct", operations },
        },
      },
      extra: true,
    });
    expect(snapshot?.workspaceRoot).toBe("/workspace");
    expect(snapshot?.facilities.files).toEqual({
      availability: "unsupported",
      access: { kind: "none" },
      reasonCode: "unavailable",
    });
    expect(snapshot?.facilities.tools.access).toEqual({
      kind: "useagent_gateway",
      discovery: "direct",
      operations: operations.slice(0, 64),
    });
    expect(snapshot?.facilities.shell).toEqual(unsupportedFacility);
    expect((snapshot as unknown as Record<string, unknown>)?.extra).toBeUndefined();
    expect(normalizeExecutionCapabilitySnapshot({ version: 2, runtime: "sandbox" })).toBeNull();
    expect(normalizeExecutionCapabilitySnapshot({ version: 1, runtime: "future" })).toBeNull();
  });

  test("downgrades usable availability when access is absent or contradictory", () => {
    const raw = structuredClone(executionCapabilities()) as unknown as {
      facilities: Record<string, unknown>;
    };
    raw.facilities.desktop = {
      availability: "ready",
      access: { kind: "future_access" },
    } as never;
    raw.facilities.browser = {
      availability: "on_demand",
      access: { kind: "user_surface_only" },
    } as const;
    const snapshot = normalizeExecutionCapabilitySnapshot(raw);
    expect(snapshot?.facilities.desktop).toEqual({
      availability: "unsupported",
      access: { kind: "none" },
    });
    expect(snapshot?.facilities.browser).toEqual({
      availability: "unsupported",
      access: { kind: "none" },
    });
  });

  test("rejects compact gateway access unless canonical operations are exact", () => {
    const raw = executionCapabilities();
    raw.facilities.browser.access.call = "other_call" as "gateway_tool_call";
    expect(normalizeExecutionCapabilitySnapshot(raw)?.facilities.browser.access).toEqual({
      kind: "none",
    });
  });
});

describe("parseSessionStartedFrame", () => {
  test("parses optional execution capabilities and supports legacy frames", () => {
    const parsed = parseSessionStartedFrame({
      source: "engine",
      capabilities: { stop: true },
      executionCapabilities: executionCapabilities(),
    });
    expect(parsed?.source).toBe("engine");
    expect(parsed?.capabilities.stop).toBe(true);
    expect(parsed?.executionCapabilities?.runtime).toBe("sandbox");
    expect(parseSessionStartedFrame({ capabilities: {} })?.executionCapabilities).toBeUndefined();
    expect(parseSessionStartedFrame({ source: "engine" })).toBeNull();
    expect(parseSessionStartedFrame(null)).toBeNull();
  });
});

describe("translateOpenCode session.started", () => {
  test("carries the optional execution snapshot into the canonical event", () => {
    const events = translateOpenCode(
      [
        frame({
          sessionId: "s1",
          capabilities: { stop: true },
          executionCapabilities: executionCapabilities(),
        }),
      ],
      CTX,
      [],
    ).events;
    const event = events.find((candidate) => candidate.kind === "session.started");
    expect(event?.identity.nativeSessionId).toBe("s1");
    if (event?.kind === "session.started") {
      expect(event.source).toBe("engine");
      expect(event.capabilities.stop).toBe(true);
      expect(event.executionCapabilities?.facilities.tools.access).toEqual({
        kind: "useagent_gateway",
        discovery: "compact",
        search: "gateway_tools_search",
        describe: "gateway_tool_describe",
        call: "gateway_tool_call",
        operations: [],
      });
    }
  });

  test("an unparseable session.started frame emits nothing and does not warn", () => {
    const all = translateOpenCode(
      [{ ...frame({ sessionId: "s1", capabilities: {} }), payload: { source: "engine" } }],
      CTX,
      [],
    ).events;
    expect(all.filter((event) => event.kind === "session.started")).toHaveLength(0);
    expect(all.filter((event) => event.kind === "harness.warning")).toHaveLength(0);
  });
});
