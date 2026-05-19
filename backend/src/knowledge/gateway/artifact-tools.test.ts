import { describe, expect, test } from "bun:test";
import { ARTIFACT_TOOLS, executeArtifactTool } from "./artifact-tools";

describe("artifact gateway contract", () => {
  test("supports editable companions and explicit screenshot-proof publication", () => {
    const publish = ARTIFACT_TOOLS.find((tool) => tool.name === "artifact_publish");
    expect(publish?.inputSchema.required).toEqual(["path"]);
    expect(publish?.inputSchema.properties.editable_path).toEqual({
      type: "string",
      description: "Optional sandbox path to editable HTML for a DOCX or CSV for an XLSX.",
    });
    expect(publish?.inputSchema.properties.purpose).toEqual({
      type: "string",
      enum: ["user_requested_proof", "deliverable"],
      description:
        "Required as user_requested_proof when publishing a private desktop inspection screenshot. Use deliverable or omit it for normal files the user requested.",
    });
    expect(publish?.description).toContain("Office bytes remain immutable");
    expect(publish?.description).toContain("purpose=user_requested_proof");
  });

  test("rejects private inspection screenshots before sandbox publication unless proof is explicit", async () => {
    const rejected = await executeArtifactTool(
      {
        orgId: "org-1",
        userId: "user-1",
        threadId: "thread-1",
        runId: "run-1",
        scope: "run",
        exp: Date.now() + 60_000,
      },
      "artifact_publish",
      { path: "/root/work/screenshots/screenshot-1786558088313.png" },
    );

    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]?.text).toContain("Private desktop inspection screenshots");

    const daytonaRejected = await executeArtifactTool(
      {
        orgId: "org-1",
        userId: "user-1",
        threadId: "thread-1",
        runId: "run-1",
        scope: "run",
        exp: Date.now() + 60_000,
      },
      "artifact_publish",
      { path: "/home/daytona/work/screenshots/screenshot-1786558088313.png" },
    );

    expect(daytonaRejected.isError).toBe(true);
  });
});
