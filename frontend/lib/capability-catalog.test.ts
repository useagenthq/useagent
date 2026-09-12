import { describe, expect, test } from "bun:test";
import { fetchCapabilityCatalog, parseCapabilityCatalog } from "./capability-catalog";

const WIRE = {
  version: 1,
  scope: "pre_run",
  engines: [
    {
      id: "opencode",
      configured: true,
      ready: true,
      defaultModel: "openai/gpt-5.6-luna",
      models: [
        { id: "openai/gpt-5.6-luna", default: true, dispatchable: true },
        { id: "new/free:free", default: false, dispatchable: true },
      ],
      runtime: { kind: "t3", label: "T3 orchestration · cloud sandbox" },
      session: { declared: {}, currentRun: null },
      execution: { declaredFacilities: ["files"], currentRun: null },
    },
  ],
  tools: {
    gatewayConfigured: true,
    declared: [
      {
        name: "artifact_publish",
        category: "artifacts",
        aliases: [],
        declared: true,
        configured: true,
        currentRunAvailable: null,
        approval: "required",
        effect: "artifact_publish",
      },
    ],
  },
  nativeSlashCommands: { catalog: "session_runtime", currentRun: null },
};

describe("browser capability catalog", () => {
  test("parses endpoint membership including a dynamic free model", () => {
    const parsed = parseCapabilityCatalog(WIRE);
    expect(parsed?.engines[0]?.models.map((model) => model.id)).toEqual([
      "openai/gpt-5.6-luna",
      "new/free:free",
    ]);
    expect(parsed?.engines[0]?.runtime).toEqual({
      kind: "t3",
      label: "T3 orchestration · cloud sandbox",
    });
    expect(parsed?.tools.declared[0]).toMatchObject({
      name: "artifact_publish",
      approval: "required",
      effect: "artifact_publish",
      currentRunAvailable: null,
    });
  });

  test("fails closed on malformed or over-broad payloads", () => {
    expect(parseCapabilityCatalog({ ...WIRE, version: 2 })).toBeNull();
    expect(
      parseCapabilityCatalog({
        ...WIRE,
        tools: {
          ...WIRE.tools,
          declared: Array.from({ length: 257 }, () => WIRE.tools.declared[0]),
        },
      }),
    ).toBeNull();
    const sanitized = parseCapabilityCatalog({
      ...WIRE,
      tools: {
        ...WIRE.tools,
        declared: [{ ...WIRE.tools.declared[0], authorizationHeader: "Bearer secret" }],
      },
    });
    expect(sanitized).not.toBeNull();
    expect(JSON.stringify(sanitized)).not.toContain("Bearer secret");
  });

  test("fetches only the authenticated capability endpoint and returns null on failure", async () => {
    const seen: string[] = [];
    const catalog = await fetchCapabilityCatalog(async (input) => {
      seen.push(String(input));
      return Response.json(WIRE);
    });
    expect(seen).toEqual(["/api/capabilities"]);
    expect(catalog?.version).toBe(1);
    expect(
      await fetchCapabilityCatalog(async () => new Response(null, { status: 401 })),
    ).toBeNull();
  });
});
