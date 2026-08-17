import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  T3ThreadErrorBanner,
} from "./thread-error-banner";

test("stays hidden after its current error is dismissed", () => {
  const bannerKey = getThreadErrorBannerKey("thread-a", "Aborted");
  dismissThreadErrorBannerForSession(bannerKey);

  expect(
    shouldShowThreadErrorBanner(
      "thread-a",
      "Aborted",
      isThreadErrorBannerDismissedForSession(bannerKey),
    ),
  ).toBe(false);
});

test("reappears when a new error arrives on the same thread", () => {
  dismissThreadErrorBannerForSession(getThreadErrorBannerKey("thread-b", "Turn failed"));
  const newErrorKey = getThreadErrorBannerKey("thread-b", "Provider crashed");

  expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
  expect(
    shouldShowThreadErrorBanner(
      "thread-b",
      "Provider crashed",
      isThreadErrorBannerDismissedForSession(newErrorKey),
    ),
  ).toBe(true);
});

test("scopes dismissals to the thread that dismissed them", () => {
  dismissThreadErrorBannerForSession(getThreadErrorBannerKey("thread-c", "Aborted"));
  const otherThreadKey = getThreadErrorBannerKey("other-thread", "Aborted");

  expect(isThreadErrorBannerDismissedForSession(otherThreadKey)).toBe(false);
  expect(
    shouldShowThreadErrorBanner(
      "other-thread",
      "Aborted",
      isThreadErrorBannerDismissedForSession(otherThreadKey),
    ),
  ).toBe(true);
});

test("never shows a null error and keeps a dismissal across errorless visits", () => {
  const bannerKey = getThreadErrorBannerKey("thread-d", "Aborted");
  dismissThreadErrorBannerForSession(bannerKey);

  expect(shouldShowThreadErrorBanner("thread-d", null, false)).toBe(false);
  expect(isThreadErrorBannerDismissedForSession(bannerKey)).toBe(true);
  expect(
    shouldShowThreadErrorBanner(
      "thread-d",
      "Aborted",
      isThreadErrorBannerDismissedForSession(bannerKey),
    ),
  ).toBe(false);
});

test("renders the real run summary as a prominent dismissible alert", () => {
  const html = renderToStaticMarkup(
    <T3ThreadErrorBanner error="Sandbox provisioning failed: quota exceeded" onDismiss={() => {}} />,
  );
  expect(html).toContain('data-t3-ui="thread-error-banner"');
  expect(html).toContain('role="alert"');
  expect(html).toContain("This run failed");
  expect(html).toContain("Sandbox provisioning failed: quota exceeded");
  expect(html).toContain('aria-label="Dismiss error"');
});

test("omits the Retry button when no retry action exists (the current product state)", () => {
  const html = renderToStaticMarkup(<T3ThreadErrorBanner error="Aborted" onDismiss={() => {}} />);
  expect(html).not.toContain("Retry");
});

test("renders Retry only for a real supplied handler", () => {
  const html = renderToStaticMarkup(<T3ThreadErrorBanner error="Aborted" onRetry={() => {}} />);
  expect(html).toContain("Retry");
});

test("renders nothing for a null error", () => {
  expect(renderToStaticMarkup(<T3ThreadErrorBanner error={null} />)).toBe("");
});
