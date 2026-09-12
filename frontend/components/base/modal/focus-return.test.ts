import { describe, expect, test } from "bun:test";
import { restoreFocus } from "./focus-return";

type FakeOpener = { isConnected: boolean; tagName: string; focused: number; focus: () => void };

function opener(overrides: Partial<FakeOpener> = {}): FakeOpener {
  const el: FakeOpener = {
    isConnected: true,
    tagName: "BUTTON",
    focused: 0,
    focus() {
      el.focused += 1;
    },
    ...overrides,
  };
  return el;
}

function closeEvent() {
  const event = { prevented: false, preventDefault: () => undefined as void };
  event.preventDefault = () => {
    event.prevented = true;
  };
  return event;
}

describe("dialog focus return", () => {
  test("returns focus to the element that opened the dialog", () => {
    const button = opener();
    const event = closeEvent();
    restoreFocus(button as unknown as HTMLElement, event as unknown as Event);
    expect(button.focused).toBe(1);
    expect(event.prevented).toBeTrue();
  });

  test("leaves the default close behaviour when the opener left the document", () => {
    const button = opener({ isConnected: false });
    const event = closeEvent();
    restoreFocus(button as unknown as HTMLElement, event as unknown as Event);
    expect(button.focused).toBe(0);
    expect(event.prevented).toBeFalse();
  });

  test("never targets body or a missing opener", () => {
    const body = opener({ tagName: "BODY" });
    const event = closeEvent();
    restoreFocus(body as unknown as HTMLElement, event as unknown as Event);
    restoreFocus(null, event as unknown as Event);
    expect(body.focused).toBe(0);
    expect(event.prevented).toBeFalse();
  });
});
