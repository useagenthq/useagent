import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Orb, ORB_TONES } from "./orb";

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

  test("defaults to the blue tone, the solid variant, a 40px ball and no face", () => {
    const html = renderToStaticMarkup(<Orb />);
    expect(html).toContain('data-tone="blue"');
    expect(html).toContain('data-variant="solid"');
    expect(html).toContain("size-10");
    expect(html).not.toContain("orb-face");
  });

  test("the ball is clipped and carries the four sheen layers; children stay outside the clip", () => {
    const html = renderToStaticMarkup(
      <Orb tone="rose" size="size-8" className="mt-1" aria-hidden>
        <span data-dot className="absolute -right-0.5 -bottom-0.5" />
      </Orb>,
    );
    expect(html).toContain('class="orb-ball absolute inset-0 overflow-hidden rounded-full"');
    for (const layer of ["glaze", "cap", "glint", "bounce"]) {
      expect(html).toContain(`data-layer="${layer}"`);
    }
    expect(html.indexOf("<span data-dot")).toBeGreaterThan(html.lastIndexOf('data-layer="bounce"'));
    expect(html).toContain("mt-1");
    expect(html).toContain('aria-hidden="true"');
  });

  test("the face variant draws two eyes above the ball at every supported size", () => {
    for (const size of ["size-5", "size-6", "size-8", "size-10", "size-14", "size-16"]) {
      const html = renderToStaticMarkup(<Orb tone="emerald" size={size} face />);
      const face = html.indexOf('class="orb-face"');
      expect(face).toBeGreaterThan(html.lastIndexOf('data-layer="bounce"'));
      expect(html.slice(face).match(/<span><\/span>/g)).toHaveLength(2);
    }
  });

  test("the prism variant carries no tone", () => {
    const prism = renderToStaticMarkup(<Orb variant="prism" />);
    expect(prism).toContain('data-variant="prism"');
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

  test("the sheen keeps the reference geometry at about half its strength", () => {
    expect(block('.orb-sheen[data-layer="glaze"]')).toContain("rgb(255 255 255 / 0.16) 100%");
    const cap = block('.orb-sheen[data-layer="cap"]');
    expect(cap).toContain("left: 7.7%");
    expect(cap).toContain("width: 84.6%");
    expect(cap).toContain("height: 38.5%");
    expect(cap).toContain("rgb(255 255 255 / 0.3) 0%");
    expect(cap).toContain("blur(0.5px)");
    const glint = block('.orb-sheen[data-layer="glint"]');
    expect(glint).toContain("left: 34.6%");
    expect(glint).toContain("blur(1px)");
    const bounce = block('.orb-sheen[data-layer="bounce"]');
    expect(bounce).toContain("top: 73.1%");
    expect(bounce).toContain("width: 138.5%");
    expect(bounce).toContain("rgb(255 255 255 / 0.22) 100%");
  });

  test("the eyes are two white dots with a soft shadow", () => {
    const eye = block(".orb-face > span");
    expect(eye).toContain("width: 16%");
    expect(eye).toContain("height: 16%");
    expect(eye).toContain("background: rgb(255 255 255)");
    expect(eye).toContain("box-shadow: 0 1px 1.5px");
  });

  test("no tone's lit center gets pale enough to swallow the white eyes", () => {
    // The eyes are graphic marks with their own drop shadow, not text; amber and
    // cyan are the palest centers today at about 1.9:1 and set the floor.
    const white: Rgb = [255, 255, 255];
    for (const tone of ORB_TONES) {
      const pair = block(`.orb[data-tone="${tone}"]`);
      const light = rgbVariable(pair, "orb-light");
      expect(contrast(white, whiteSheen(light, 0.15))).toBeGreaterThanOrEqual(1.8);
    }
  });

  test("the prism variant is a pastel conic sweep with a dark ring on the wrapper", () => {
    expect(block('.orb[data-variant="prism"] > .orb-ball')).toContain("conic-gradient(");
    expect(block('.orb[data-variant="prism"]')).toContain("0 0 0 2px rgb(0 0 0 / 0.35)");
    const eye = block('.orb[data-variant="prism"] > .orb-face > span');
    expect(eye).toContain("background: rgb(0 0 0)");
    expect(eye).toContain("rgb(255 255 255 / 0.45)");
  });
});
