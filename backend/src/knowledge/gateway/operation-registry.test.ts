import { describe, expect, test } from "bun:test";

import { LOOP_LOGIN_TOOLS } from "./loop-login-tools";
import {
  advertisedGatewayToolDescriptors,
  baseGatewayToolDescriptors,
} from "./operation-registry";
import { SLACK_TOOLS } from "./slack-tools";

describe("gateway operation registry", () => {
  test("keeps the always-available catalog unique and well described", () => {
    const tools = baseGatewayToolDescriptors();
    const names = tools.map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);
    expect(
      tools.every(
        (tool) =>
          tool.name.length > 0 &&
          tool.description.length > 0 &&
          typeof tool.inputSchema === "object",
      ),
    ).toBe(true);
  });

  test("advertises conditional capabilities only when their trusted context is present", () => {
    const baseNames = new Set(
      advertisedGatewayToolDescriptors({ loopLogin: false, slack: false }).map(
        (tool) => tool.name,
      ),
    );
    const enabledNames = new Set(
      advertisedGatewayToolDescriptors({ loopLogin: true, slack: true }).map(
        (tool) => tool.name,
      ),
    );

    for (const tool of LOOP_LOGIN_TOOLS) {
      expect(baseNames.has(tool.name)).toBe(false);
      expect(enabledNames.has(tool.name)).toBe(true);
    }
    for (const tool of SLACK_TOOLS) {
      expect(baseNames.has(tool.name)).toBe(false);
      expect(enabledNames.has(tool.name)).toBe(true);
    }
  });
});
