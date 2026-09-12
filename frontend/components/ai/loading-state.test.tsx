import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_LOADING_PATTERN, LOADING_PATTERNS, LoadingState, PixelLoader } from "./loading-state";

const cells = (html: string) => html.match(/<span[^>]*class="[^"]*size-1[^"]*"/g) ?? [];

describe("pixel loader", () => {
  test("every pattern renders a 3x3 grid of animated cells", () => {
    for (const pattern of LOADING_PATTERNS) {
      const html = renderToStaticMarkup(<PixelLoader pattern={pattern} />);
      expect(html).toContain(`data-pattern="${pattern}"`);
      expect(cells(html)).toHaveLength(9);
      expect(html).toContain("ai-loading-pixel");
    }
  });

  test("drive and dots share the chevron wavefront; only dots is round", () => {
    const drive = renderToStaticMarkup(<PixelLoader pattern="drive" />);
    const dots = renderToStaticMarkup(<PixelLoader pattern="dots" />);
    expect(drive).toContain("animation-delay:270ms");
    expect(dots).toContain("animation-delay:270ms");
    expect(dots).toContain("rounded-full");
    expect(drive).not.toContain("rounded-full");
  });

  test("orbit laps the perimeter on a slower cycle and leaves the center dark", () => {
    const html = renderToStaticMarkup(<PixelLoader pattern="orbit" />);
    expect(html).toContain("animation-duration:950ms");
    expect(html).toContain("animation-delay:770ms");
    expect(cells(html).filter((cell) => cell.includes("ai-loading-pixel"))).toHaveLength(8);
    expect(html).toContain("opacity-[0.07]");
  });

  test("the step-row size is a 14px glyph and the default pattern is one switch", () => {
    const html = renderToStaticMarkup(<PixelLoader size="sm" />);
    expect(html).toContain("gap-px");
    expect(html).toContain(`data-pattern="${DEFAULT_LOADING_PATTERN}"`);
    expect(LOADING_PATTERNS).toContain(DEFAULT_LOADING_PATTERN);
  });

  test("LoadingState pairs the grid with the shimmer label", () => {
    const html = renderToStaticMarkup(<LoadingState label="Working" />);
    expect(html).toContain("agent-progress-loading-text");
    expect(html).toContain(">Working<");
    expect(cells(html)).toHaveLength(9);
  });
});
