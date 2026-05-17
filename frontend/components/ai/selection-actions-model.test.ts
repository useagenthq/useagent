import { describe, expect, test } from "bun:test";

import {
  createSelectionActionsState,
  selectionActionsReducer,
  visibleSelectionText,
} from "./selection-actions-model";

describe("selection actions state", () => {
  test("moves a rewrite through thinking, streaming, and confirmation", () => {
    const idle = createSelectionActionsState();
    const thinking = selectionActionsReducer(idle, {
      type: "request",
      request: "improve",
    });
    const streaming = selectionActionsReducer(thinking, {
      type: "stream",
      replacement: "A clearer replacement.",
    });
    const result = selectionActionsReducer(streaming, { type: "complete" });

    expect(thinking).toEqual({
      phase: "thinking",
      request: "improve",
      replacement: null,
    });
    expect(streaming.phase).toBe("streaming");
    expect(result.phase).toBe("result");
    expect(visibleSelectionText(result, "Original text.")).toBe("A clearer replacement.");
  });

  test("keeps, discards, and regenerates without coupling actions to demo copy", () => {
    const result = createSelectionActionsState({
      phase: "result",
      request: "make this warmer",
      replacement: "A warm, reusable result.",
    });

    expect(selectionActionsReducer(result, { type: "keep" })).toEqual({
      phase: "accepted",
      request: "make this warmer",
      replacement: "A warm, reusable result.",
    });
    expect(selectionActionsReducer(result, { type: "discard" })).toEqual(
      createSelectionActionsState(),
    );
    expect(selectionActionsReducer(result, { type: "retry" })).toEqual({
      phase: "thinking",
      request: "make this warmer",
      replacement: null,
    });
  });
});
