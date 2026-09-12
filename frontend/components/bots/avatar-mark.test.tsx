import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AvatarMark, botOrb } from "./avatar-mark";
import { BOT_AVATAR_TONES } from "./types";

describe("AvatarMark", () => {
  test("is an orb on the theme's state ramp with the role glyph centered on it", () => {
    const html = renderToStaticMarkup(<AvatarMark tone="violet" icon="research" size="size-8" />);
    expect(html).toContain('class="orb ');
    expect(html).toContain("--orb-tone:hsl(var(--feature-base))");
    expect(html).toContain('data-variant="solid"');
    expect(html).toContain("<svg");
    expect(html).toContain("size-4");
  });

  test("the picker offers the prism ball and it renders as the prism variant", () => {
    expect(BOT_AVATAR_TONES).toContain("prism");
    expect(botOrb("prism")).toEqual({ variant: "prism" });
    expect(renderToStaticMarkup(<AvatarMark tone="prism" icon="compass" />)).toContain('data-variant="prism"');
  });

  test("an unknown tone falls back to the primary orb", () => {
    expect(botOrb("teal")).toEqual({ tone: "primary" });
  });

  test("the state dot rides the orb", () => {
    const html = renderToStaticMarkup(<AvatarMark tone="blue" icon="robot" state="working" />);
    expect(html).toContain("bg-success-base");
    expect(renderToStaticMarkup(<AvatarMark tone="blue" icon="robot" />)).not.toContain("bg-success-base");
  });
});

/** Every file that paints a bot: the roster, thread header and drawer, the
 *  first-message hero, onboarding, the New bot dialog, the turn identity and
 *  the @ picker. Their only way to a tone is the Orb behind AvatarMark. */
const BOT_SITES = [
  ...readdirSync(import.meta.dir)
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
    .map((name) => join(import.meta.dir, name)),
  join(import.meta.dir, "..", "chat", "composer-mentions-ui.tsx"),
  join(import.meta.dir, "..", "chat", "mention-row-mark.tsx"),
];

describe("one avatar language", () => {
  test("AvatarMark renders through the kit Orb", () => {
    expect(readFileSync(join(import.meta.dir, "avatar-mark.tsx"), "utf8")).toContain('from "@/components/base/orb/orb"');
  });

  test("no bot site paints a flat tone disc of its own", () => {
    // The state dot's success/warning fill is the one legitimate flat tone.
    const flat = /toneClass|bg-(primary|feature|error|verified|highlighted|away)-base/;
    const offenders = BOT_SITES.filter((file) => flat.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
