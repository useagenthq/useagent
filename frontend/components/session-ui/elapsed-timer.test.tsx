import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ElapsedTimer } from "./elapsed-timer";

test("the timer renders the current elapsed text in tabular figures", () => {
  const html = renderToStaticMarkup(<ElapsedTimer startedAt={new Date().toISOString()} />);
  expect(html).toContain("tabular-nums");
  expect(html).toContain("0s");
});
