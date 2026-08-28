import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandItemGlyph,
  CommandList,
  commandSubstringFilter,
} from "./command";

// The picker grammar's one promise: search row, group headings and item rows
// share a single alignment grid (a fixed 16px leading column at the same left
// inset), with grouped rows and keyboard-selectable items driven by cmdk.

test("substring filter matches value or keywords, order-preserving (1/0 scores)", () => {
  expect(commandSubstringFilter("OpenCode", "code")).toBe(1);
  expect(commandSubstringFilter("claude-sonnet", "GLM")).toBe(0);
  // caption/keywords are searchable too
  expect(commandSubstringFilter("Review PR", "playbook", ["playbook"])).toBe(1);
  // empty query keeps everything
  expect(commandSubstringFilter("anything", "  ")).toBe(1);
});

test("search row and item rows share the fixed 16px leading column", () => {
  const html = renderToStaticMarkup(
    <Command label="Pick">
      <CommandInput placeholder="Search things..." />
      <CommandList>
        <CommandGroup heading="Engines">
          <CommandItem value="opencode">
            <CommandItemGlyph>
              <svg aria-hidden />
            </CommandItemGlyph>
            OpenCode
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>,
  );
  // cmdk substrate is live (input combobox, listbox, option rows, group heading)
  expect(html).toContain("cmdk-input");
  expect(html).toContain('role="option"');
  expect(html).toContain("cmdk-group-heading");
  expect(html).toContain("Engines");
  // the shared glyph column: one w-4 slot in the search row, one in the item
  const glyphSlots = html.match(/flex w-4 shrink-0 items-center justify-center/g) ?? [];
  expect(glyphSlots.length).toBe(2);
  // rows are the 32px density pass at 13px labels
  expect(html).toContain("min-h-8");
  expect(html).toContain("h-8");
  expect(html).toContain("text-body-2-medium");
});

test("group heading carries an optional trailing action", () => {
  const html = renderToStaticMarkup(
    <Command label="Pick">
      <CommandList>
        <CommandGroup
          heading="Free"
          action={<button type="button" tabIndex={-1} aria-label="Refresh free models" />}
        >
          <CommandItem value="glm">GLM</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>,
  );
  expect(html).toContain("Free");
  expect(html).toContain('aria-label="Refresh free models"');
});
