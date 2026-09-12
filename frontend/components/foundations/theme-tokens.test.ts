import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type TokenMap = Record<string, string>;

const globals = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const themeCss = readFileSync(new URL("../../styles/theme.css", import.meta.url), "utf8");
const readSource = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const extractBlock = (selector: string, source = globals): string => {
  const start = source.indexOf(selector);
  if (start === -1) throw new Error(`missing ${selector} token block`);

  const open = source.indexOf("{", start);
  if (open === -1) throw new Error(`missing opening brace for ${selector}`);

  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
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
// theme.css opens with a comment that quotes these selectors, so anchor at line start.
const lightSemantic = parseTokens(extractBlock("\n:root {", themeCss));
const darkSemantic = parseTokens(extractBlock("\n.dark {", themeCss));

/** The un-layered per-theme overlay (the block that carries the component
 *  tokens), as opposed to the layered ramp block with the same selector. */
const componentOverlay = (selector: string): TokenMap => {
  const overlay = extractBlocks(selector)
    .map(parseTokens)
    .find((tokens) => tokens["--color-text-tertiary"]);
  if (!overlay) throw new Error(`missing ${selector} component overlay`);
  return overlay;
};

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
  test("light theme maps the achromatic neutral ramp through the legacy semantic tokens", () => {
    expect(lightTokens["--neutral-950"]).toBe("0 0% 3.92%");
    expect(lightTokens["--neutral-200"]).toBe("0 0% 92.16%");
    expect(lightTokens["--neutral-100"]).toBe("0 0% 96.08%");
    expect(lightTokens["--neutral-50"]).toBe("0 0% 96.86%");
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
    expect(resolveToken(lightTokens, "--bg-weak-50")).toBe("0 0% 96.08%");
    expect(resolveToken(lightTokens, "--stroke-soft-200")).toBe("0 0% 92.16%");

    expect(contrast("#0a0a0a", "#f7f7f7")).toBeGreaterThanOrEqual(7);
  });

  test("light secondary and tertiary text clear AA on every light surface", () => {
    // Both tiers carry real text (nav rows, section labels, times, captions,
    // secondary button labels, placeholders), so they must pass on the canvas
    // (#f7f7f7), the panel fill (#f5f5f5, background-secondary-default), the
    // white cards and the #ebebeb field fill, not just the white panels.
    expect(lightSemantic["--color-text-secondary"]).toBe("var(--color-neutral-600)");
    expect(lightSemantic["--color-text-tertiary"]).toBe("#666666");
    expect(lightSemantic["--color-text-placeholder"]).toBe("var(--color-text-tertiary)");
    for (const surface of ["#ffffff", "#fafafa", "#f7f7f7", "#f5f5f5", "#ebebeb"]) {
      expect(contrast("#525252", surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#666666", surface)).toBeGreaterThanOrEqual(4.5);
    }
    // Tertiary icons clear the 3:1 non-text floor on the same surfaces.
    expect(lightSemantic["--color-foreground-icon-tertiary"]).toBe("var(--color-neutral-500)");
    for (const surface of ["#ffffff", "#f5f5f5", "#ebebeb"]) {
      expect(contrast("#737373", surface)).toBeGreaterThanOrEqual(3);
    }
    // Keyboard hint: neutral-700 on the neutral-300 key cap.
    expect(lightSemantic["--color-kbd-foreground"]).toBe("var(--color-neutral-700)");
    expect(contrast("#404040", "#d4d4d4")).toBeGreaterThanOrEqual(4.5);
  });

  test("accent-as-text uses the text-accent token and clears AA in light and dark", () => {
    expect(lightSemantic["--color-text-accent"]).toBe("var(--color-accent-600)");
    expect(darkSemantic["--color-text-accent"]).toBe("var(--color-accent-300)");
    for (const selector of [".dusk {", ".aura {", ".harbor {", ".phosphor {", ".slate {", ".sakura-night {"]) {
      expect(componentOverlay(selector)["--color-text-accent"]).toBe("var(--color-accent-300)");
    }
    // accent-600 (#155dfc) on the light panel fill; accent-300 (#8ec5ff) on the
    // dark, dusk and harbor panels.
    expect(contrast("#155dfc", "#f5f5f5")).toBeGreaterThanOrEqual(4.5);
    for (const panel of ["#262626", "#2e2e2e", "#1f212d", "#1c1f24"]) {
      expect(contrast("#8ec5ff", panel)).toBeGreaterThanOrEqual(4.5);
    }
    const pillTab = readSource("components/base/tabs/pill-tab.tsx");
    expect(pillTab).toContain("text-text-accent");
    expect(pillTab).not.toContain("text-accent-500");
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
    // Muted text (#9499b7) keeps headroom over 5:1 on the raised panel #252838,
    // and the kbd cap sits on the neutral-500 step so the hint clears AA.
    expect(duskTokens["--neutral-200"]).toBe("232.11 19.39% 65%");
    expect(contrast("#9499b7", "#252838")).toBeGreaterThanOrEqual(5);
    expect(componentOverlay(".dusk {")["--color-kbd-background"]).toBe("hsl(var(--neutral-500))");
    expect(contrast("#b1b8da", "#3c4260")).toBeGreaterThanOrEqual(4.5);

    const swatchTokens = parseTokens(extractBlock(".theme-swatch-dusk {"));
    expect(swatchTokens["--swatch-canvas"]).toBe("#1f212d");
    expect(swatchTokens["--swatch-accent"]).toBe("#2b7fff");
  });

  test("Dusk participates in every shared dark-theme behavior", () => {
    expectSharedDarkRuleIncludesDusk(".dark,", ".dusk");
    expectSharedDarkRuleIncludesDusk(".dark .bg-halftone,", ".dusk .bg-halftone");
    // Dusk deliberately leaves the shared shiki swap: its ramp is Tokyo Night,
    // so it carries a dedicated `--shiki-dusk` palette rule instead.
    expect(extractSelectorList(".dusk .shiki,")).toContain(".dusk .shiki span");
    expect(extractBlock(".dusk .shiki,")).toContain("var(--shiki-dusk)");
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

  test("Dusk status chips clear AA on the raised panel", () => {
    // Chip text sits on a 12% tint of itself over the raised panel (#252838).
    // The ramp's 24% alpha put red / purple / yellow under 4.5:1.
    // `.dusk {` appears twice (ramp block, then component overlay): take the
    // overlay, the block that actually defines the status tokens.
    const duskComponentTokens = extractBlocks(".dusk {")
      .map(parseTokens)
      .find((tokens) => tokens["--color-status-lime-background"]);
    expect(duskComponentTokens).toBeDefined();
    const panel = "#252838";
    const blend = (hex: string, alpha: number): string => {
      const channel = (offset: number): string => {
        const fg = parseInt(hex.slice(offset, offset + 2), 16);
        const bg = parseInt(panel.slice(offset, offset + 2), 16);
        return Math.round(fg * alpha + bg * (1 - alpha)).toString(16).padStart(2, "0");
      };
      return `#${channel(1)}${channel(3)}${channel(5)}`;
    };
    for (const [token, hex] of [
      ["--color-status-lime-background", "#9ece6a"],
      ["--color-status-rose-background", "#f7768e"],
      ["--color-status-yellow-background", "#e0af68"],
      ["--color-status-blue-background", "#8ec5ff"],
      ["--color-status-cyan-background", "#7dcfff"],
      ["--color-status-purple-background", "#bb9af7"],
    ] as const) {
      expect(duskComponentTokens?.[token]).toMatch(/\/ 12%\)$/);
      expect(contrast(hex, blend(hex, 0.12))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("primary CTA label preserves readable contrast", () => {
    // White label on the primary CTA gradient's darker stop (blue-600 #155dfc).
    expect(contrast("#ffffff", "#155dfc")).toBeGreaterThanOrEqual(4.5);
  });

  test("selected navigation rows keep a white label readable at BOTH gradient stops", () => {
    // accent-500 (#2b7fff) at the top stop only reached 3.76:1, so the
    // selected sidebar and settings-rail rows use accent-600 to accent-700.
    expect(contrast("#ffffff", "#155dfc")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", "#1447e6")).toBeGreaterThanOrEqual(4.5);
    for (const rel of ["components/shell/sidebar-nav.tsx", "app/settings/settings-rail.tsx"]) {
      const source = readSource(rel);
      expect(source).toContain("from-accent-600 to-accent-700 text-white");
      expect(source).not.toContain("from-accent-500 to-accent-600");
    }
  });

  test("every standalone dark overlay defines the same component token set as Dusk", () => {
    // Harbor once lacked the eleven accent overrides, so accent tints fell
    // through to the light pastels. Midnight (.dark) is excluded on purpose:
    // it inherits theme.css's .dark block and only re-points neutral slots.
    const dusk = componentOverlay(".dusk {");
    const expected = Object.keys(dusk).filter(
      (key) => key.startsWith("--color-") || key.startsWith("--gradient-"),
    );
    for (const selector of [".aura {", ".harbor {", ".phosphor {", ".slate {", ".sakura-night {"]) {
      const overlay = componentOverlay(selector);
      const missing = expected.filter((key) => !(key in overlay));
      expect(missing, `${selector} is missing ${missing.join(", ")}`).toEqual([]);
    }
    // Harbor's interactive blue stays the standard ramp (a settled decision),
    // so its accent stops must not reference the periwinkle legacy --blue-* vars.
    const harbor = componentOverlay(".harbor {");
    for (const stop of [300, 400, 500, 600, 700, 800, 900, 950]) {
      expect(harbor[`--color-accent-${stop}`]).toBe(`var(--color-blue-${stop})`);
    }
  });

  test("status chips have an orange pair in every theme", () => {
    expect(lightSemantic["--color-status-orange-background"]).toBe("var(--color-orange-200)");
    expect(lightSemantic["--color-status-orange-text"]).toBe("var(--color-orange-800)");
    expect(darkSemantic["--color-status-orange-text"]).toBe("var(--color-orange-500)");
    for (const selector of [".dusk {", ".aura {", ".harbor {", ".phosphor {", ".slate {", ".sakura-night {"]) {
      expect(componentOverlay(selector)["--color-status-orange-text"]).toBeDefined();
    }
    // orange-800 (#9f2d00) on orange-200 (#ffd6a8) in light.
    expect(contrast("#9f2d00", "#ffd6a8")).toBeGreaterThanOrEqual(4.5);
    expect(readSource("components/base/badges/chip.tsx")).toContain("bg-status-orange-background text-status-orange-text");
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
