import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { T3ProviderStatusBanner, unavailableEngineLabel } from "./provider-status-banner";

test("a listed engine is never flagged", () => {
  expect(unavailableEngineLabel("opencode", ["opencode", "claude"])).toBeNull();
});

test("an engine missing from the manifest resolves to its display label", () => {
  expect(unavailableEngineLabel("claude", ["opencode"])).toBe("Claude Code");
  expect(unavailableEngineLabel("codex", ["opencode", "claude"])).toBe("Codex");
});

test("an EMPTY (unresolved) manifest never flags anything", () => {
  expect(unavailableEngineLabel("claude", [])).toBeNull();
});

test("renders a slim honest unavailable notice", () => {
  const html = renderToStaticMarkup(<T3ProviderStatusBanner engineLabel="Claude Code" />);
  expect(html).toContain('data-t3-ui="provider-status-banner"');
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
    <T3ProviderStatusBanner engineLabel="Codex" onDismiss={() => {}} />,
  );
  expect(html).toContain('aria-label="Dismiss Codex status"');
});
