import { expect, test } from "bun:test";
import { THEME_OPTIONS } from "./theme-menu";

test("orders Light and Dark first, then preserves the remaining theme order", () => {
  expect(THEME_OPTIONS.map((theme) => theme.label)).toEqual([
    "Light",
    "Dark",
    "Midnight",
    "Dusk",
    "Aura",
    "Dark Green",
    "Light Green",
    "Light Red",
    "Dark Red",
    "Slate",
  ]);
});
