import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { T3BackgroundStatusPill } from "./background-status-pill";

test("renders the status label, pulsing dot, and Stop action", () => {
  const html = renderToStaticMarkup(
    <T3BackgroundStatusPill label="Monitoring in the background" onStop={() => {}} />,
  );
  expect(html).toContain('data-t3-ui="background-status-pill"');
  expect(html).toContain('role="status"');
  expect(html).toContain("Monitoring in the background");
  expect(html).toContain("ai-loading-pixel");
  expect(html).toContain("Stop");
  expect(html).not.toContain("for "); // no elapsed without a start time
});

test("shows the self-ticking elapsed when a start time is known", () => {
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  const html = renderToStaticMarkup(
    <T3BackgroundStatusPill label="Run in progress" startedAt={startedAt} onStop={() => {}} />,
  );
  expect(html).toContain("for ");
  expect(html).toContain("1m 5s");
});

test("stopping disables the button and flips its label", () => {
  const html = renderToStaticMarkup(
    <T3BackgroundStatusPill label="Run in progress" stopping onStop={() => {}} />,
  );
  expect(html).toContain("Stopping...");
  expect(html).toContain("disabled");
});
