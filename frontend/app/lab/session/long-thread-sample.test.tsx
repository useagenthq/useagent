import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LongThreadSample } from "./long-thread-sample";

test("the fixed-height long-thread harness gives Conversation a flex height owner", () => {
  const html = renderToStaticMarkup(<LongThreadSample />);
  const surface = html.match(/<div[^>]*data-testid="long-thread-surface"[^>]*>/)?.[0];

  expect(surface).toBeDefined();
  expect(surface).toContain("flex");
  expect(surface).toContain("h-[76vh]");
  expect(surface).toContain("flex-col");
  expect(html).toContain("Reply to Agent");
});
