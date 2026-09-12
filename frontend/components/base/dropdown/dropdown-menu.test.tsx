import { expect, test } from "bun:test";
import { Menu } from "react-aria-components";
import { renderToStaticMarkup } from "react-dom/server";
import { DropdownMenuItem } from "./dropdown";

/**
 * The popover itself portals to document.body, so the closed menu renders
 * nothing on the server; the row contract is what a static render can pin.
 * Arrow keys, typeahead and close-on-select are React Aria behaviour and are
 * walked in the browser (headless Playwright) rather than here.
 */
test("menu rows are menuitemradios with aria-checked under single selection", () => {
  const html = renderToStaticMarkup(
    <Menu aria-label="Theme" selectionMode="single" selectedKeys={["dark"]}>
      <DropdownMenuItem id="light" textValue="Light">
        <span>Light</span>
      </DropdownMenuItem>
      <DropdownMenuItem id="dark" textValue="Midnight">
        <span>Midnight</span>
      </DropdownMenuItem>
    </Menu>,
  );
  expect(html).toContain('role="menu"');
  expect(html.match(/role="menuitemradio"/g)).toHaveLength(2);
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain('aria-checked="false"');
  expect(html).not.toContain("<button");
});

test("action rows are plain menuitems", () => {
  const html = renderToStaticMarkup(
    <Menu aria-label="Account menu">
      <DropdownMenuItem id="settings" textValue="Settings">
        <span>Settings</span>
      </DropdownMenuItem>
    </Menu>,
  );
  expect(html).toContain('role="menuitem"');
  expect(html).not.toContain("menuitemradio");
});
