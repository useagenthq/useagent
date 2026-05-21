import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as Tooltip from "@/components/ui/tooltip";
import { MessageCopyButton } from "./message-copy-button";

test("idle state renders the copy affordance with an honest label", () => {
  const html = renderToStaticMarkup(
    <Tooltip.Provider>
      <MessageCopyButton text="The settled answer." />
    </Tooltip.Provider>,
  );
  expect(html).toContain('data-session-ui="message-copy-button"');
  expect(html).toContain('aria-label="Copy message"');
  expect(html).toContain('type="button"');
});
