import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorPane } from "./editor-pane";
import type { ApiStep } from "./types";

test("a touched file with no captured body says where to look instead", () => {
  const step: ApiStep = {
    id: "s1",
    run_id: "r1",
    idx: 0,
    kind: "file",
    chip: "file",
    label: "edit",
    code_json: JSON.stringify({ tool: "edit", input: { file_path: "src/app.ts" } }),
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
  const html = renderToStaticMarkup(<EditorPane steps={[step]} live={false} />);
  expect(html).toContain("src/app.ts");
  // The body is usually not captured, so no promise that it will show up here.
  expect(html).toContain("The contents aren&#x27;t shown here. Open Diff to see what changed, or ask the agent to show you this file.");
});
