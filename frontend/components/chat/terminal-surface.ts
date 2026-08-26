/**
 * Pure configuration helpers for the interactive terminal's render surface:
 * font-stack construction, font preloading requests, the terminal color
 * theme, and resize bookkeeping. Kept free of DOM access (except the typed
 * renderer cast at the bottom) so the choreography is unit-testable.
 *
 * The font-family quoting and four-variant font-load choreography are
 * vendored from T3 Code (t3code apps/web/src/terminal/ghostty/surface.ts,
 * commit 7c1bdd6e1c7690d348464f4d7ef0783ec0f67286, MIT License).
 */

import type { CanvasRenderer, ITheme } from "ghostty-web";

/**
 * Locally installed fallback faces. Concrete names only: an unknown keyword
 * (like `ui-monospace`) makes canvas font shorthand parsing reject the WHOLE
 * string, and ghostty-web measures + rasterizes through `ctx.font`. The Nerd
 * Font names only supply prompt symbols (powerline separators, devicons) when
 * the user has one installed; they never change metrics for plain text.
 */
export const TERMINAL_FALLBACK_FONTS =
  '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", ' +
  '"JetBrainsMono Nerd Font", "FiraCode Nerd Font", "Hack Nerd Font", ' +
  '"MesloLGS NF", monospace';

/** Every style the renderer can request; loading only the regular face leaves
 * bold/italic output rasterizing from a synthesized or fallback font. */
const TERMINAL_FONT_LOAD_VARIANTS = [
  "normal 400",
  "normal 700",
  "italic 400",
  "italic 700",
] as const;

export const TERMINAL_FONT_LOAD_TEXT = "iMW0@# .";

/**
 * Quote non-ident family names ("JetBrains Mono", next/font's hashed
 * "__JetBrains_Mono_abc123"): one unquoted name makes the whole canvas font
 * string invalid and the `ctx.font` assignment silently no-ops, leaving the
 * terminal measuring and drawing with the 10px sans-serif canvas default.
 */
export function quoteTerminalFontFamilies(list: string): string {
  return list
    .split(",")
    .map((name) => {
      const bare = name.trim();
      if (bare.length === 0) return "";
      if (/^(['"]).*\1$/.test(bare)) return bare;
      if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
      return `"${bare.replaceAll('"', "")}"`;
    })
    .filter((name) => name.length > 0)
    .join(", ");
}

/** Build the full stack: the app's mono face first, concrete fallbacks after. */
export function terminalFontFamily(preferred?: string): string {
  const custom = preferred === undefined ? "" : quoteTerminalFontFamilies(preferred);
  if (custom.length === 0) return TERMINAL_FALLBACK_FONTS;
  return `${custom}, ${TERMINAL_FALLBACK_FONTS}`;
}

/** The `document.fonts.load` requests covering every renderable style. */
export function terminalFontLoadRequests(family: string, size: number): string[] {
  return TERMINAL_FONT_LOAD_VARIANTS.map((variant) => `${variant} ${size}px ${family}`);
}

/**
 * Tokyo Night terminal palette (folke/tokyonight "night" terminal colors),
 * matching the app chrome's dark ramp: primary text #c0caf5, secondary
 * #a9b1d6, accent #7aa2f7. The background stays caller-supplied so the canvas
 * blends seamlessly into the pane it sits in. Without an explicit 16-color
 * palette ghostty-web falls back to VS Code's default ANSI colors, which
 * clash with the chrome.
 */
export function terminalTheme(background: string): ITheme {
  return {
    background,
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    cursorAccent: background,
    selectionBackground: "#283457",
    selectionForeground: "#c0caf5",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  };
}

export interface TerminalGrid {
  readonly cols: number;
  readonly rows: number;
}

/** Backend notices that mean the PTY has no live sandbox yet. Keep these out of
 * the terminal buffer so reconnect backoff cannot turn one idle state into an
 * ever-growing wall of wrapped status text. */
export function isIdleTerminalNotice(text: string): boolean {
  return (
    text.includes("no live sandbox") ||
    /\[(?:skynet|useAgent)\][^\n]*\bno-sandbox\b/i.test(text) ||
    /\[(?:skynet|useAgent)\][^\n]*not found/i.test(text) ||
    /\[(?:skynet|useAgent)\][^\n]*sandbox is probably not running anymore/i.test(text)
  );
}

/** Whether the PTY needs a resize message: only on settled dimension change. */
export function gridChanged(previous: TerminalGrid | null, next: TerminalGrid): boolean {
  return previous === null || previous.cols !== next.cols || previous.rows !== next.rows;
}

/**
 * ghostty-web's CanvasRenderer captures `window.devicePixelRatio` once at
 * construction, so a browser zoom or a move to another monitor leaves the
 * backing store at the stale ratio and every glyph blurry. The field is
 * private in the type but plain on the instance; updating it makes the
 * per-frame `canvas.width !== cols * cellWidth * dpr` check in `render()`
 * reconfigure the canvas and repaint crisply on the next frame.
 */
export function applyDevicePixelRatio(renderer: CanvasRenderer, ratio: number): void {
  (renderer as unknown as { devicePixelRatio: number }).devicePixelRatio = ratio;
}
