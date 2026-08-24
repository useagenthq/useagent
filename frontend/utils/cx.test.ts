import { describe, expect, test } from "bun:test";
import { cx } from "@/utils/cx";

describe("cx typography merging", () => {
  test.each(["text-label-sm", "text-paragraph-sm", "text-subheading-2xs"])(
    "preserves %s when combined with a text color",
    (typographyClass) => {
      expect(cx(typographyClass, "text-text-primary")).toBe(`${typographyClass} text-text-primary`);
    },
  );
});
