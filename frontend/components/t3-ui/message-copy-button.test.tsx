import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as Tooltip from "@/components/ui/tooltip";
import { T3MessageCopyButton } from "./message-copy-button";

test("idle state renders the copy affordance with an honest label", () => {
  const html = renderToStaticMarkup(
    <Tooltip.Provider>
      <T3MessageCopyButton text="The settled answer." />
    </Tooltip.Provider>,
  );
  expect(html).toContain('data-t3-ui="message-copy-button"');
  expect(html).toContain('aria-label="Copy message"');
  expect(html).toContain('type="button"');
});
