import { describe, expect, test } from "bun:test";
import { workpieceFollowUpMessage } from "./workpiece-follow-up";

describe("workpieceFollowUpMessage", () => {
  const ref = {
    artifactId: "artifact-1",
    name: "Launch brief.docx",
    kind: "document" as const,
    revision: 3,
  };

  test("prefixes the typed workpiece reference so the agent targets the right doc", () => {
    expect(workpieceFollowUpMessage(ref, "Tighten the intro")).toBe(
      'Regarding workpiece artifact-1 ("Launch brief.docx", document, revision 3):\nTighten the intro',
    );
  });

  test("trims the user's text so stray whitespace never leaks into the reply", () => {
    expect(workpieceFollowUpMessage(ref, "   add a summary  ")).toBe(
      'Regarding workpiece artifact-1 ("Launch brief.docx", document, revision 3):\nadd a summary',
    );
  });

  test("carries the current revision and kind for any workpiece kind", () => {
    const sheet = { artifactId: "a2", name: "Model.xlsx", kind: "spreadsheet" as const, revision: 0 };
    expect(workpieceFollowUpMessage(sheet, "fix the totals")).toContain(
      'workpiece a2 ("Model.xlsx", spreadsheet, revision 0)',
    );
  });
});
