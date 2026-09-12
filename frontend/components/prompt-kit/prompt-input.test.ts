import { describe, expect, test } from "bun:test";
import { observeTextareaWidth, resizeTextareaToContent } from "./prompt-input";

describe("prompt input autosize", () => {
  test("restored multiline content remeasures once when its width changes", () => {
    let resize: ResizeObserverCallback = () => {};
    let width = 480;
    let measurements = 0;
    let disconnected = false;
    const style = { height: "240px" };
    const textarea = {
      value: "First restored line\nSecond restored line\nThird restored line",
      style,
      scrollHeight: 96,
      getBoundingClientRect: () => ({ width }),
    } as unknown as HTMLTextAreaElement;

    const disconnect = observeTextareaWidth(
      textarea,
      () => {
        measurements += 1;
        resizeTextareaToContent(textarea, 240);
      },
      (callback) => {
        resize = callback;
        return {
          observe: () => {},
          disconnect: () => {
            disconnected = true;
          },
        };
      },
    );

    resize([{ contentRect: { width: 480 } } as ResizeObserverEntry], {} as ResizeObserver);
    expect(measurements).toBe(0);

    width = 320;
    resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
    expect(measurements).toBe(1);
    expect(style.height).toBe("96px");

    // Height writes can produce another observer delivery; an unchanged width
    // must not trigger another measurement loop.
    resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
    expect(measurements).toBe(1);

    disconnect();
    expect(disconnected).toBe(true);
  });
});
