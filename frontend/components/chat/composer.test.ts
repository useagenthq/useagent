import { describe, expect, test } from "bun:test";

import { getComposerAction } from "./composer";

describe("composer action contract", () => {
  test("keeps idle drafts on the compact send action", () => {
    expect(getComposerAction({ running: false, hasDraft: true, canStop: true })).toEqual({
      kind: "send",
      label: "Send",
    });
  });

  test("labels a non-empty active-run draft as steer", () => {
    expect(getComposerAction({ running: true, hasDraft: true, canStop: true })).toEqual({
      kind: "steer",
      label: "Steer",
    });
  });

  test("keeps an empty active-run draft on the separate stop action", () => {
    expect(getComposerAction({ running: true, hasDraft: false, canStop: true })).toEqual({
      kind: "stop",
      label: "Stop this run",
    });
  });

  test("falls back to a disabled send action when stopping is unavailable", () => {
    expect(getComposerAction({ running: true, hasDraft: false, canStop: false })).toEqual({
      kind: "send",
      label: "Send",
    });
  });
});
