import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Orb, ORB_DARK_INK, ORB_TONES } from "./orb";

type Rgb = readonly [number, number, number];

function luminance(rgb: Rgb): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

function rgbVariable(block: string, name: string): Rgb {
  const match = new RegExp(`--${name}: rgb\\((\\d+) (\\d+) (\\d+)\\)`).exec(block);
  if (!match) throw new Error(`missing ${name} RGB variable`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function whiteSheen(rgb: Rgb, alpha: number): Rgb {
  return [
    Math.round(rgb[0] * (1 - alpha) + 255 * alpha),
    Math.round(rgb[1] * (1 - alpha) + 255 * alpha),
    Math.round(rgb[2] * (1 - alpha) + 255 * alpha),
  ];
}

describe("Orb", () => {
  test("every tone is stamped on the element and carries no raw color in markup", () => {
    for (const tone of ORB_TONES) {
      const html = renderToStaticMarkup(<Orb tone={tone} />);
      expect(html).toContain(`data-tone="${tone}"`);
      expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(html).not.toContain("rgb(");
    }
  });

  test("defaults to the blue tone, the solid variant and a 40px ball", () => {
    const html = renderToStaticMarkup(<Orb />);
    expect(html).toContain('data-tone="blue"');
    expect(html).toContain('data-variant="solid"');
    expect(html).toContain("size-10");
  });

  test("the ball is clipped and carries the four sheen layers; children stay outside the clip", () => {
    const html = renderToStaticMarkup(
      <Orb tone="rose" size="size-8" className="mt-1" aria-hidden>
        <svg data-glyph />
        <span data-dot className="absolute -right-0.5 -bottom-0.5" />
      </Orb>,
    );
    const ball = html.indexOf('class="orb-ball absolute inset-0 overflow-hidden rounded-full"');
    expect(ball).toBeGreaterThan(-1);
    for (const layer of ["glaze", "cap", "glint", "bounce"]) {
      expect(html).toContain(`data-layer="${layer}"`);
    }
    expect(html.indexOf("<svg data-glyph")).toBeGreaterThan(html.lastIndexOf('data-layer="bounce"'));
    expect(html).toContain("<span data-dot");
    expect(html).toContain("mt-1");
    expect(html).toContain('aria-hidden="true"');
  });

  test("ink follows the tone: black on the bright centers, white elsewhere, black on prism", () => {
    for (const tone of ORB_TONES) {
      const html = renderToStaticMarkup(<Orb tone={tone} />);
      expect(html).toContain(`data-ink="${ORB_DARK_INK.has(tone) ? "dark" : "light"}"`);
    }
    expect(ORB_DARK_INK).toEqual(new Set(["emerald", "amber", "cyan"]));
    const prism = renderToStaticMarkup(<Orb variant="prism" />);
    expect(prism).toContain('data-variant="prism"');
    expect(prism).toContain('data-ink="dark"');
    expect(prism).not.toContain("data-tone=");
  });
});

describe("the orb recipe in globals.css", () => {
  const css = readFileSync(join(import.meta.dir, "..", "..", "..", "app", "globals.css"), "utf8");
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  };

  test("every tone has a fixed light and deep pair, the same in every theme", () => {
    for (const tone of ORB_TONES) {
      const pair = block(`.orb[data-tone="${tone}"]`);
      expect(pair).toMatch(/--orb-light: rgb\(\d+ \d+ \d+\)/);
      expect(pair).toMatch(/--orb-deep: rgb\(\d+ \d+ \d+\)/);
      expect(pair).not.toContain("var(--");
    }
  });

  test("the ball is a light-center to deep-edge radial with no shadow or glow", () => {
    const ball = block(".orb > .orb-ball");
    expect(ball).toContain("radial-gradient(circle closest-side, var(--orb-light) 0%, var(--orb-deep) 100%)");
    expect(block(".orb")).not.toContain("box-shadow");
    expect(ball).not.toContain("box-shadow");
  });

  test("the four sheen layers match the reference geometry", () => {
    expect(block('.orb-sheen[data-layer="glaze"]')).toContain("rgb(255 255 255 / 0.3) 100%");
    const cap = block('.orb-sheen[data-layer="cap"]');
    expect(cap).toContain("left: 7.7%");
    expect(cap).toContain("width: 84.6%");
    expect(cap).toContain("height: 38.5%");
    expect(cap).toContain("blur(0.5px)");
    const glint = block('.orb-sheen[data-layer="glint"]');
    expect(glint).toContain("left: 34.6%");
    expect(glint).toContain("blur(1px)");
    const bounce = block('.orb-sheen[data-layer="bounce"]');
    expect(bounce).toContain("top: 73.1%");
    expect(bounce).toContain("width: 138.5%");
  });

  test("ink is white by default, black when the component says so, with a shadow only under white", () => {
    expect(block(".orb")).toContain("color: rgb(255 255 255)");
    expect(block('.orb[data-ink="dark"]')).toContain("color: rgb(0 0 0)");
    expect(block('.orb[data-ink="light"] > svg')).toContain("drop-shadow(");
  });

  test("the palette keeps glyph contrast above 3:1 after the center sheen", () => {
    const white: Rgb = [255, 255, 255];
    const black: Rgb = [0, 0, 0];
    for (const tone of ORB_TONES) {
      const pair = block(`.orb[data-tone="${tone}"]`);
      const light = rgbVariable(pair, "orb-light");
      const deep = rgbVariable(pair, "orb-deep");
      const foreground = ORB_DARK_INK.has(tone) ? black : white;
      const centerWithSheen = whiteSheen(light, 0.15);
      const worstBackground = ORB_DARK_INK.has(tone) ? deep : centerWithSheen;
      expect(contrast(foreground, worstBackground)).toBeGreaterThanOrEqual(3);
      if (tone === "fuchsia" || tone === "slate") {
        expect(contrast(foreground, whiteSheen(light, 0.2))).toBeGreaterThanOrEqual(3.2);
      }
    }
  });

  test("the prism variant is a pastel conic sweep with a dark ring on the wrapper", () => {
    expect(block('.orb[data-variant="prism"] > .orb-ball')).toContain("conic-gradient(");
    expect(block('.orb[data-variant="prism"]')).toContain("0 0 0 2px rgb(0 0 0 / 0.35)");
  });
});
