import { expect, test } from "bun:test";

import { hrefWithoutAgentFocus } from "./use-agents-rail-deep-link";

test("clearing native-agent focus preserves unrelated query state", () => {
  expect(hrefWithoutAgentFocus(
    "/session/thread-1",
    "agent_execution=execution-1&agent_run=run-1",
  )).toBe("/session/thread-1");
  expect(
    hrefWithoutAgentFocus(
      "/session/thread-1",
      "panel=wide&agent_execution=execution-1&agent_run=run-1&tab=files",
    ),
  ).toBe("/session/thread-1?panel=wide&tab=files");
});
