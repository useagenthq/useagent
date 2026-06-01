import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderStatusBanner, unavailableEngineLabel } from "./provider-status-banner";

test("a listed engine is never flagged", () => {
  expect(unavailableEngineLabel("opencode", ["opencode", "claude"], true)).toBeNull();
});

test("an engine missing from the manifest resolves to its display label", () => {
  expect(unavailableEngineLabel("claude", ["opencode"], true)).toBe("Claude Code");
  expect(unavailableEngineLabel("codex", ["opencode", "claude"], true)).toBe("Codex");
});

test("the loading fallback never produces a false unavailable warning", () => {
  expect(unavailableEngineLabel("codex", ["opencode"], false)).toBeNull();
});

test("renders a slim honest unavailable notice", () => {
  const html = renderToStaticMarkup(<ProviderStatusBanner engineLabel="Claude Code" />);
  expect(html).toContain('data-session-ui="provider-status-banner"');
  expect(html).toContain('role="alert"');
  expect(html).toContain("Claude Code is currently unavailable on this server.");
  expect(html).toContain("may fail until it returns");
  // Honest wording only: no certainty the manifest cannot back.
  expect(html).not.toContain("will fail");
  // No dismiss handler, no X.
  expect(html).not.toContain("aria-label=");
});

test("renders an accessible dismiss control when a handler is supplied", () => {
  const html = renderToStaticMarkup(
    <ProviderStatusBanner engineLabel="Codex" onDismiss={() => {}} />,
  );
  expect(html).toContain('aria-label="Dismiss Codex status"');
});
