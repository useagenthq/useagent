import { describe, expect, test } from "bun:test";
import { ARTIFACT_TOOLS } from "./artifact-tools";

describe("artifact gateway contract", () => {
  test("supports an editable companion without making it mandatory", () => {
    const publish = ARTIFACT_TOOLS.find((tool) => tool.name === "artifact_publish");
    expect(publish?.inputSchema.required).toEqual(["path"]);
    expect(publish?.inputSchema.properties.editable_path).toEqual({
      type: "string",
      description: "Optional sandbox path to editable HTML for a DOCX or CSV for an XLSX.",
    });
    expect(publish?.description).toContain("Office bytes remain immutable");
  });
});
