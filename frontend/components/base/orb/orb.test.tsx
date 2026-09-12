import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Orb, ORB_TONES } from "./orb";

describe("Orb", () => {
  test("every tone resolves to its semantic theme variable, never a raw color", () => {
    for (const tone of ORB_TONES) {
      const html = renderToStaticMarkup(<Orb tone={tone} />);
      expect(html).toContain(`--orb-tone:hsl(var(--${tone}-base))`);
      expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  test("defaults to the primary tone, the solid variant and a 40px ball", () => {
    const html = renderToStaticMarkup(<Orb />);
    expect(html).toContain('data-variant="solid"');
    expect(html).toContain("--orb-tone:hsl(var(--primary-base))");
    expect(html).toContain("--orb-px:40");
    expect(html).toContain("size-10");
  });

  test("the prism variant is the iridescent ball", () => {
    expect(renderToStaticMarkup(<Orb variant="prism" />)).toContain('data-variant="prism"');
  });

  test("the gloss scales with the size class", () => {
    expect(renderToStaticMarkup(<Orb size="size-5" />)).toContain("--orb-px:20");
    expect(renderToStaticMarkup(<Orb size="size-16" />)).toContain("--orb-px:64");
  });

  test("renders a glyph child centered on the ball and passes through attributes", () => {
    const html = renderToStaticMarkup(
      <Orb tone="success" size="size-8" className="mt-1" aria-hidden>
        <svg data-glyph />
      </Orb>,
    );
    expect(html).toContain("<svg data-glyph");
    expect(html).toContain("items-center justify-center");
    expect(html).toContain("mt-1");
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("the orb recipe in globals.css", () => {
  const css = readFileSync(join(import.meta.dir, "..", "..", "..", "app", "globals.css"), "utf8");
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  };

  test("reads the tone the component sets and paints the gloss from it alone", () => {
    const orb = block(".orb");
    expect(orb).toContain("var(--orb-tone)");
    expect(orb).toContain("var(--orb-px");
    expect(orb).toContain("radial-gradient(circle at 32% 26%");
    expect(orb).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  test("decides the glyph ink from the tone's own luminance at the 3:1 line", () => {
    const orb = block(".orb");
    expect(orb).toContain("--orb-y: color(from var(--orb-tone) srgb-linear");
    expect(orb).toContain("0.2126 * r + 0.7152 * g + 0.0722 * b");
    expect(orb).toContain("color: var(--orb-ink)");
  });

  test("the prism variant is a conic sweep with a dark ring and black ink", () => {
    const prism = block('.orb[data-variant="prism"]');
    expect(prism).toContain("conic-gradient(");
    expect(prism).toContain("0 0 0 2px rgb(0 0 0 / 0.35)");
    expect(prism).toContain("--orb-ink: hsl(var(--static-black))");
  });
});
