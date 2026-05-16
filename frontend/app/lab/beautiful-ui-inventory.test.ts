import { describe, expect, test } from "bun:test";

import manifest from "@/vendor/beautiful-ui/manifest.json";

import { BEAUTIFUL_UI_COMPONENTS } from "./beautiful-ui-inventory";

describe("Beautiful UI lab inventory", () => {
  test("exposes every vendored component exactly once", () => {
    const manifestSlugs = manifest.components.map(({ slug }) => slug).toSorted();
    const labSlugs = [...BEAUTIFUL_UI_COMPONENTS].toSorted();

    expect(labSlugs).toHaveLength(19);
    expect(new Set(labSlugs).size).toBe(19);
    expect(labSlugs).toEqual(manifestSlugs);
  });
});
