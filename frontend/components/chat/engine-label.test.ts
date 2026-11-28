import { describe, expect, test } from "bun:test";
import { ENGINES, engineLabel } from "@/components/chat/types";

/** Bots, automations and the chat surfaces all name an engine through `engineLabel`, so
 *  these rows are what every page shows for a stored engine id. */
const LEGACY: Array<[id: string, label: string]> = [
  ["claude-sdk", "Claude SDK"],
  ["daytona", "Cloud"],
  ["mock", "Mock"],
  ["acp", "ACP"],
];

describe("engineLabel", () => {
  test.each(ENGINES.map(({ id, label }) => [id, label]))("names %s from the engine catalog", (id, label) => {
    expect(engineLabel(id)).toBe(label);
  });

  test.each(LEGACY)("names the retired id %s without offering it as a choice", (id, label) => {
    expect(engineLabel(id)).toBe(label);
    expect(ENGINES.map((engine) => engine.id)).not.toContain(id);
  });

  test("shows an unknown id as stored, never an inherited object key", () => {
    expect(engineLabel("future-engine")).toBe("future-engine");
    expect(engineLabel("constructor")).toBe("constructor");
    expect(engineLabel("")).toBe("");
  });
});
