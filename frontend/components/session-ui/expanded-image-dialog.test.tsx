import { expect, test } from "bun:test";
import { expandedImageCaption } from "./expanded-image-dialog";

// The dialog itself mounts through the Radix portal (client-only), so static
// markup cannot capture it; the pure caption logic is what SSR tests can hold.

test("caption is the bare name for a single image", () => {
  expect(expandedImageCaption("screenshot.png", 0, 1)).toBe("screenshot.png");
});

test("caption carries the position when browsing a set", () => {
  expect(expandedImageCaption("screenshot.png", 1, 3)).toBe("screenshot.png (2/3)");
});
