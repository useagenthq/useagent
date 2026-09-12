import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BotRepositories } from "./bot-repositories";

test("bot repository scope names home and routine use without promising handoff authority", () => {
  const html = renderToStaticMarkup(
    <BotRepositories value={["useagenthq/app"]} onChange={() => {}} locked />,
  );
  expect(html).toContain("Home and routine repositories are fixed");
  expect(html).toContain("Handoffs inherit the parent thread&#x27;s repositories.");
  expect(html).toContain("useagenthq/app");
});
