import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type TokenMap = Record<string, string>;

const globals = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

const extractBlock = (selector: string): string => {
  const start = globals.indexOf(selector);
  if (start === -1) throw new Error(`missing ${selector} token block`);

  const open = globals.indexOf("{", start);
  if (open === -1) throw new Error(`missing opening brace for ${selector}`);

  let depth = 0;
  for (let index = open; index < globals.length; index++) {
    const char = globals[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return globals.slice(open + 1, index);
  }

  throw new Error(`missing closing brace for ${selector}`);
};

const extractBlocks = (selector: string): string[] => {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < globals.length) {
    const start = globals.indexOf(selector, cursor);
    if (start === -1) break;
    const open = globals.indexOf("{", start);
    if (open === -1) break;
    let depth = 0;
    for (let index = open; index < globals.length; index++) {
      const char = globals[index];
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth === 0) {
        blocks.push(globals.slice(open + 1, index));
        cursor = index + 1;
        break;
      }
    }
  }
  return blocks;
};

const parseTokens = (block: string): TokenMap => {
  const tokens: TokenMap = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^\s*(--[\w-]+):\s*([^;]+);/);
    if (match?.[1] && match[2]) tokens[match[1]] = match[2].trim();
  }
  return tokens;
};

const resolveToken = (tokens: TokenMap, name: string): string => {
  const value = tokens[name];
  if (!value) throw new Error(`missing token ${name}`);

  const reference = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return reference ? resolveToken(tokens, reference) : value;
};

const lightTokens = parseTokens(extractBlock(":root,"));
const darkTokens = parseTokens(extractBlock(".dark {"));
const duskTokens = parseTokens(extractBlock(".dusk {"));

const extractSelectorList = (selector: string): string => {
  const selectorIndex = globals.indexOf(selector);
  if (selectorIndex === -1) throw new Error(`missing ${selector} rule`);

  const previousClose = globals.lastIndexOf("}", selectorIndex);
  const open = globals.indexOf("{", selectorIndex);
  if (open === -1) throw new Error(`missing opening brace for ${selector}`);

  return globals.slice(previousClose + 1, open);
};

const expectSharedDarkRuleIncludesDusk = (darkSelector: string, duskSelector: string): void => {
  expect(extractSelectorList(darkSelector)).toContain(duskSelector);
};

describe("shared theme tokens", () => {
  test("light theme maps the warm neutral ramp through the legacy semantic tokens", () => {
    expect(lightTokens["--neutral-950"]).toBe("0 0% 3.92%");
    expect(lightTokens["--neutral-200"]).toBe("40 12.5% 90.59%");
    expect(lightTokens["--neutral-100"]).toBe("45 16.67% 95.29%");
    expect(lightTokens["--neutral-50"]).toBe("45 28.57% 97.25%");
    expect(lightTokens["--neutral-0"]).toBe("0 0% 100%");
    expect(lightTokens["--blue-500"]).toBe("216.23 100% 58.43%");

    expect(lightTokens["--primary-base"]).toBe("var(--blue-500)");
    expect(lightTokens["--bg-white-0"]).toBe("var(--neutral-0)");
    expect(lightTokens["--bg-weak-50"]).toBe("var(--neutral-100)");
    expect(lightTokens["--text-strong-950"]).toBe("var(--neutral-950)");
    expect(lightTokens["--text-sub-600"]).toBe("var(--neutral-500)");
    expect(lightTokens["--stroke-soft-200"]).toBe("var(--neutral-200)");
    expect(lightTokens["--success-dark"]).toBe("var(--green-950)");
    expect(lightTokens["--feature-base"]).toBe("var(--purple-500)");
    expect(resolveToken(lightTokens, "--bg-weak-50")).toBe("45 16.67% 95.29%");
    expect(resolveToken(lightTokens, "--stroke-soft-200")).toBe("40 12.5% 90.59%");

    expect(contrast("#0a0a0a", "#faf9f6")).toBeGreaterThanOrEqual(7);
    expect(contrast("#737373", "#faf9f6")).toBeGreaterThanOrEqual(4.5);
  });

  test("dark theme maps the achromatic graphite ramp through the legacy semantic tokens", () => {
    // The measured achromatic graphite ladder (canvas #121212, panel #262626)
    // - matches the reference neutral ramp, zero hue tint in surfaces.
    expect(resolveToken(darkTokens, "--bg-white-0")).toBe("0 0% 14.9%");
    expect(resolveToken(darkTokens, "--bg-weak-50")).toBe("0 0% 9.02%");
    expect(resolveToken(darkTokens, "--bg-soft-200")).toBe("0 0% 9.02%");
    expect(resolveToken(darkTokens, "--bg-sub-300")).toBe("0 0% 18.04%");

    expect(resolveToken(darkTokens, "--text-strong-950")).toBe("0 0% 98.04%");
    expect(resolveToken(darkTokens, "--text-sub-600")).toBe("0 0% 63.14%");
    expect(resolveToken(darkTokens, "--text-soft-400")).toBe("0 0% 45.1%");
    expect(resolveToken(darkTokens, "--text-disabled-300")).toBe("0 0% 25.1%");

    expect(resolveToken(darkTokens, "--stroke-soft-200")).toBe("0 0% 20%");
    expect(resolveToken(darkTokens, "--stroke-sub-300")).toBe("0 0% 25.1%");
    expect(resolveToken(darkTokens, "--primary-base")).toBe("216.23 100% 58.43%");
    expect(resolveToken(darkTokens, "--verified-dark")).toBe("202.15 100% 74.51%");
    expect(resolveToken(darkTokens, "--success-dark")).toBe("88.8 50.51% 61.18%");
    expect(resolveToken(darkTokens, "--error-dark")).toBe("348.84 88.97% 71.57%");

    // WCAG AA on the actual graphite surfaces: primary and muted text against
    // the page backdrop (#121212), panel (#262626), and raised (#2e2e2e) steps.
    expect(contrast("#fafafa", "#121212")).toBeGreaterThanOrEqual(7);
    expect(contrast("#fafafa", "#262626")).toBeGreaterThanOrEqual(7);
    expect(contrast("#a1a1a1", "#121212")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#a1a1a1", "#262626")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#a1a1a1", "#2e2e2e")).toBeGreaterThanOrEqual(4.5);
  });

  test("Dusk keeps its legacy canvas and uses its actual primary accent", () => {
    expect(resolveToken(duskTokens, "--bg-white-0")).toBe("231.43 18.42% 14.9%");
    expect(resolveToken(duskTokens, "--primary-base")).toBe("216.23 100% 58.43%");

    const swatchTokens = parseTokens(extractBlock(".theme-swatch-dusk {"));
    expect(swatchTokens["--swatch-canvas"]).toBe("#1f212d");
    expect(swatchTokens["--swatch-accent"]).toBe("#2b7fff");
  });

  test("Dusk participates in every shared dark-theme behavior", () => {
    expectSharedDarkRuleIncludesDusk(".dark,", ".dusk");
    expectSharedDarkRuleIncludesDusk(".dark .bg-halftone,", ".dusk .bg-halftone");
    expectSharedDarkRuleIncludesDusk(".dark .shiki,", ".dusk .shiki");
    expectSharedDarkRuleIncludesDusk("html.dark,", "html.dusk");
    expectSharedDarkRuleIncludesDusk(".dark .theme-logo-light,", ".dusk .theme-logo-light");
    expectSharedDarkRuleIncludesDusk(".dark .theme-asset-light,", ".dusk .theme-asset-light");
    expectSharedDarkRuleIncludesDusk(".dark .theme-logo-dark,", ".dusk .theme-logo-dark");
    expectSharedDarkRuleIncludesDusk(".dark .theme-asset-dark,", ".dusk .theme-asset-dark");
    expectSharedDarkRuleIncludesDusk(
      ".dark .bui-agent-thinking-stars,",
      ".dusk .bui-agent-thinking-stars",
    );

    for (const shadow of [
      "2xs",
      "xs",
      "sm",
      "md",
      "lg",
      "xl",
      "card",
      "dropdown",
      "sidebar",
      "waitlist",
    ]) {
      expectSharedDarkRuleIncludesDusk(`.dark .shadow-${shadow},`, `.dusk .shadow-${shadow}`);
    }
  });

  test("primary CTA label preserves readable contrast", () => {
    // White label on the primary CTA gradient's darker stop (blue-600 #155dfc).
    expect(contrast("#ffffff", "#155dfc")).toBeGreaterThanOrEqual(4.5);
  });

  test("Light Green uses AA-readable tertiary text on its mint canvas", () => {
    const blocks = extractBlocks(".phosphor-light {").map(parseTokens);
    const semantic = blocks.find((tokens) => tokens["--color-text-tertiary"]);
    expect(semantic?.["--color-text-tertiary"]).toBe("hsl(var(--neutral-500))");
    expect(contrast("#4e7358", "#f2f8f3")).toBeGreaterThanOrEqual(4.5);
  });
});

const contrast = (foreground: string, background: string): number => {
  const [foregroundLuminance, backgroundLuminance] = [foreground, background]
    .map(relativeLuminance)
    .toSorted((left, right) => right - left);

  if (foregroundLuminance === undefined || backgroundLuminance === undefined) {
    throw new Error("missing luminance");
  }

  return (foregroundLuminance + 0.05) / (backgroundLuminance + 0.05);
};

const relativeLuminance = (hex: string): number => {
  const rgb = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);

  if (rgb?.length !== 3) throw new Error(`invalid hex color ${hex}`);

  const [red, green, blue] = rgb.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );

  if (red === undefined || green === undefined || blue === undefined) {
    throw new Error(`invalid rgb color ${hex}`);
  }

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};
