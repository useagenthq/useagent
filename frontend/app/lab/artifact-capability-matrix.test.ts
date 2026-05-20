import { describe, expect, test } from "bun:test";

import { ARTIFACT_CAPABILITY_ROWS } from "./artifact-capability-matrix";

describe("artifact capability lab matrix", () => {
  test("renders the shared authoring profiles and action contract without local MIME policy", () => {
    expect(ARTIFACT_CAPABILITY_ROWS.map((row) => ({
      kind: row.kind,
      editState: row.edit?.state,
      actions: row.actions,
    }))).toEqual([
      {
        kind: "document",
        editState: "html",
        actions: ["download"],
      },
      {
        kind: "spreadsheet",
        editState: "csv",
        actions: ["download"],
      },
      {
        kind: "presentation",
        editState: "slides",
        actions: ["download"],
      },
      {
        kind: "pdf",
        editState: "pdfText",
        actions: ["preview", "download"],
      },
    ]);
  });
});
