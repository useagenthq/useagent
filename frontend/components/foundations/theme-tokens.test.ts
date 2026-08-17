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

describe("shared theme tokens", () => {
  test("light theme keeps the existing semantic mappings unchanged", () => {
    expect(lightTokens["--neutral-950"]).toBe("221.54 31.71% 8.04%");
    expect(lightTokens["--neutral-0"]).toBe("0 0% 100%");
    expect(lightTokens["--blue-500"]).toBe("197 92% 51%");

    expect(lightTokens["--primary-base"]).toBe("var(--blue-500)");
    expect(lightTokens["--bg-white-0"]).toBe("var(--neutral-0)");
    expect(lightTokens["--bg-weak-50"]).toBe("var(--neutral-50)");
    expect(lightTokens["--text-strong-950"]).toBe("var(--neutral-950)");
    expect(lightTokens["--text-sub-600"]).toBe("var(--neutral-600)");
    expect(lightTokens["--stroke-soft-200"]).toBe("var(--neutral-200)");
    expect(lightTokens["--success-dark"]).toBe("var(--green-950)");
    expect(lightTokens["--feature-base"]).toBe("var(--purple-500)");
  });

  test("dark theme maps Tokyo Night upstream colors through semantic tokens", () => {
    expect(resolveToken(darkTokens, "--bg-white-0")).toBe("235 18.75% 12.55%");
    expect(resolveToken(darkTokens, "--bg-weak-50")).toBe("240 15.38% 8.82%");
    expect(resolveToken(darkTokens, "--bg-soft-200")).toBe("240 15.38% 10.2%");
    expect(resolveToken(darkTokens, "--bg-sub-300")).toBe("234 18.52% 15.88%");

    expect(resolveToken(darkTokens, "--text-strong-950")).toBe("228.68 72.6% 85.69%");
    expect(resolveToken(darkTokens, "--text-sub-600")).toBe("229.33 35.43% 75.1%");
    expect(resolveToken(darkTokens, "--text-soft-400")).toBe("232.73 13.92% 53.53%");
    expect(resolveToken(darkTokens, "--text-disabled-300")).toBe("230.32 16.06% 37.84%");

    expect(resolveToken(darkTokens, "--stroke-soft-200")).toBe("229.09 23.4% 21.37%");
    expect(resolveToken(darkTokens, "--stroke-sub-300")).toBe("232.17 16.31% 27.65%");
    expect(resolveToken(darkTokens, "--primary-base")).toBe("223.2 45.05% 43.53%");
    expect(resolveToken(darkTokens, "--verified-dark")).toBe("202.15 100% 74.51%");
    expect(resolveToken(darkTokens, "--success-dark")).toBe("88.8 50.51% 61.18%");
    expect(resolveToken(darkTokens, "--error-dark")).toBe("348.84 88.97% 71.57%");
  });

  test("dark theme preserves readable foreground contrast on Tokyo Night surfaces", () => {
    expect(contrast("#c0caf5", "#1a1b26")).toBeGreaterThanOrEqual(7);
    expect(contrast("#a9b1d6", "#1a1b26")).toBeGreaterThanOrEqual(7);
    expect(contrast("#ffffff", "#3d59a1")).toBeGreaterThanOrEqual(4.5);
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
