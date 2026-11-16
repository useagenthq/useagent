import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SlashCommandPopover } from "./slash-command";

test("the slash command listbox carries its own id, so aria-controls names the list", () => {
  const html = renderToStaticMarkup(
    <SlashCommandPopover matches={[]} highlight={0} onSelect={() => {}} />,
  );
  expect(html).toContain('id="slashcmd-listbox"');
  expect(html).toMatch(/id="slashcmd-listbox"[^>]*role="listbox"|role="listbox"[^>]*id="slashcmd-listbox"/);
});
