import { describe, expect, test } from "bun:test";
import { Ghostty } from "ghostty-web";

import {
  TERMINAL_FALLBACK_FONTS,
  gridChanged,
  quoteTerminalFontFamilies,
  terminalFontFamily,
  terminalFontLoadRequests,
  terminalTheme,
  isIdleTerminalNotice,
  isTerminalUnavailableNotice,
} from "./terminal-surface";

test("fresh parser instances do not inherit disposed terminal cells", async () => {
  const wasm = new URL("../../node_modules/ghostty-web/ghostty-vt.wasm", import.meta.url);
  const old = (await Ghostty.load(wasm.pathname)).createTerminal(80, 24);
  old.write("PRIVATE_OLD_SCREEN 한글 漢字 👩‍💻 🇺🇸\r\n");
  old.free();
  const next = (await Ghostty.load(wasm.pathname)).createTerminal(80, 24);
  try {
    expect(next.getViewport().filter((cell) => cell.codepoint > 32)).toHaveLength(0);
    next.write("NEW_SESSION_OK");
    const line = next.getLine(0);
    if (!line) throw new Error("new terminal has no first row");
    expect(String.fromCodePoint(...line.map((cell) => cell.codepoint || 32)).trim())
      .toBe("NEW_SESSION_OK");
  } finally {
    next.free();
  }
});

describe("quoteTerminalFontFamilies", () => {
  test("quotes names that are not plain idents", () => {
    expect(quoteTerminalFontFamilies("JetBrains Mono, monospace")).toBe(
      '"JetBrains Mono", monospace',
    );
    // next/font's hashed families start with underscores - not a CSS ident.
    expect(quoteTerminalFontFamilies("__JetBrains_Mono_3c557b")).toBe(
      '"__JetBrains_Mono_3c557b"',
    );
  });

  test("preserves already-quoted names and drops empties", () => {
    expect(quoteTerminalFontFamilies("'JetBrains Mono', , \"SF Mono\", Menlo")).toBe(
      "'JetBrains Mono', \"SF Mono\", Menlo",
    );
  });

  test("strips embedded double quotes before re-quoting", () => {
    expect(quoteTerminalFontFamilies('My "Weird" Font')).toBe('"My Weird Font"');
  });
});

describe("terminalFontFamily", () => {
  test("falls back to the concrete stack without a preferred face", () => {
    expect(terminalFontFamily()).toBe(TERMINAL_FALLBACK_FONTS);
    expect(terminalFontFamily("")).toBe(TERMINAL_FALLBACK_FONTS);
  });

  test("puts the preferred face first and keeps the fallbacks", () => {
    const stack = terminalFontFamily("JetBrains Mono");
    expect(stack.startsWith('"JetBrains Mono", ')).toBe(true);
    expect(stack.endsWith(TERMINAL_FALLBACK_FONTS)).toBe(true);
  });

  test("never emits generic keywords canvas font parsing rejects", () => {
    // ui-monospace in a ctx.font shorthand silently invalidates the whole
    // string in some engines; the stack must stay concrete-names-only.
    expect(terminalFontFamily("JetBrains Mono")).not.toContain("ui-monospace");
    expect(TERMINAL_FALLBACK_FONTS).not.toContain("ui-monospace");
  });
});

describe("terminalFontLoadRequests", () => {
  test("covers regular, bold, italic, and bold-italic at the given size", () => {
    expect(terminalFontLoadRequests('"JetBrains Mono", monospace', 13)).toEqual([
      'normal 400 13px "JetBrains Mono", monospace',
      'normal 700 13px "JetBrains Mono", monospace',
      'italic 400 13px "JetBrains Mono", monospace',
      'italic 700 13px "JetBrains Mono", monospace',
    ]);
  });
});

describe("terminalTheme", () => {
  test("supplies the complete 16-color ANSI palette", () => {
    const theme = terminalTheme("rgb(10, 10, 10)");
    const ansi = [
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ] as const;
    for (const key of ansi) {
      // Without every slot filled, ghostty-web merges in its VS Code default
      // palette, which clashes with the Tokyo Night chrome.
      expect(theme[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("keeps the canvas background seamless with the host pane", () => {
    const theme = terminalTheme("rgb(10, 10, 10)");
    expect(theme.background).toBe("rgb(10, 10, 10)");
    expect(theme.cursorAccent).toBe("rgb(10, 10, 10)");
  });

  test("overrides the default selection colors", () => {
    const theme = terminalTheme("#17181a");
    expect(theme.selectionBackground).toBe("#283457");
    expect(theme.selectionForeground).toBe("#c0caf5");
  });
});

describe("gridChanged", () => {
  test("always notifies the first grid", () => {
    expect(gridChanged(null, { cols: 80, rows: 24 })).toBe(true);
  });

  test("suppresses identical dimensions", () => {
    expect(gridChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false);
  });

  test("notifies when either axis changes", () => {
    expect(gridChanged({ cols: 80, rows: 24 }, { cols: 81, rows: 24 })).toBe(true);
    expect(gridChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(true);
  });
});

describe("isIdleTerminalNotice", () => {
  test("recognizes every backend dead or idle sandbox notice", () => {
    expect(isIdleTerminalNotice("[skynet] no live sandbox for this run")).toBe(true);
    expect(isIdleTerminalNotice("\u001b[2m[useAgent] no-sandbox\u001b[0m")).toBe(true);
    expect(isIdleTerminalNotice("[skynet] Sandbox tpl-123 not found")).toBe(true);
    expect(isIdleTerminalNotice("[skynet] Sandbox is probably not running anymore")).toBe(true);
    expect(isIdleTerminalNotice("[useAgent] Sandbox tpl-123 not found")).toBe(true);
    expect(isIdleTerminalNotice("[useAgent] Sandbox is probably not running anymore")).toBe(true);
  });

  test("preserves real terminal output", () => {
    expect(isIdleTerminalNotice("root@tpl-123:~/work# bun test")).toBe(false);
    expect(isIdleTerminalNotice("Sandbox integration tests passed")).toBe(false);
  });
});

describe("isTerminalUnavailableNotice", () => {
  test("a missing personal connection is permanent, not an idle sandbox", () => {
    const notice = "\r\n\x1b[2m[useAgent] terminal unavailable: the recorded personal connection was not found\x1b[0m\r\n";
    expect(isTerminalUnavailableNotice(notice)).toBe(true);
    expect(isIdleTerminalNotice(notice)).toBe(false);
  });
  test("recognizes the backend's declared capability gap and nothing else", () => {
    expect(isTerminalUnavailableNotice(
      "\r\n\x1b[2m[useAgent] terminal unavailable: the daytona connection that created this sandbox has been revoked\x1b[0m\r\n",
    )).toBe(true);
    expect(
      isTerminalUnavailableNotice(
        "\r\n\x1b[2m[useAgent] terminal unavailable: Box terminals need the Box CLI (box) installed on the useAgent server\x1b[0m\r\n",
      ),
    ).toBe(true);
    expect(isTerminalUnavailableNotice("\r\n\x1b[2m[useAgent] no live sandbox yet\x1b[0m\r\n")).toBe(false);
    expect(isTerminalUnavailableNotice("\x1b[31m[useAgent] run not found\x1b[0m")).toBe(false);
    expect(isTerminalUnavailableNotice("$ ls\r\nterminal unavailable: nope")).toBe(false);
  });
});
