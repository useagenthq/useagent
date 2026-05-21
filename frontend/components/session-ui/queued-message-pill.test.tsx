import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { queuedPillLabel, QueuedMessagePill } from "./queued-message-pill";

test("labels state the honest FIFO position, never a countdown", () => {
  expect(queuedPillLabel(1)).toBe("Queued - sends after the current run");
  expect(queuedPillLabel(2)).toBe("Queued #2 - 1 reply ahead");
  expect(queuedPillLabel(3)).toBe("Queued #3 - 2 replies ahead");
});

test("head queued pill is right-aligned and carries the Send now steering", () => {
  const html = renderToStaticMarkup(<QueuedMessagePill position={1} onSendNow={() => {}} />);
  expect(html).toContain('data-session-ui="queued-message-pill"');
  expect(html).toContain("justify-end");
  expect(html).toContain('role="status"');
  expect(html).toContain("Queued - sends after the current run");
  expect(html).toContain("Send now");
});

test("non-head pill shows its position without the steering affordance", () => {
  const html = renderToStaticMarkup(<QueuedMessagePill position={2} />);
  expect(html).toContain("Queued #2 - 1 reply ahead");
  expect(html).not.toContain("Send now");
});
