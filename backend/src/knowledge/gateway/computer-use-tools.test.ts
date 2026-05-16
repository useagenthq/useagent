import { afterEach, describe, expect, test } from "bun:test";
import {
  COMPUTER_USE_TOOLS,
  executeComputerUseTool,
  setComputerUseServiceForTest,
  x11KeyCommand,
  x11KeyName,
} from "./computer-use-tools";
import type { ToolTokenClaims } from "./token";

const claims: ToolTokenClaims = {
  orgId: "org-1",
  userId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  scope: "run",
  exp: Date.now() + 60_000,
};

function testService(calls: string[]) {
  return {
    screenshot: async () => ({
      content: [
        { type: "image" as const, data: "cG5n", mimeType: "image/png" as const },
        { type: "text" as const, text: "Desktop screenshot captured at /root/work/screenshots/proof.png." },
      ],
      structuredContent: { path: "/root/work/screenshots/proof.png" },
    }),
    click: async (_claims: ToolTokenClaims, x: number, y: number, button: string, double: boolean) => {
      calls.push(`click:${x}:${y}:${button}:${double}`);
    },
    move: async (_claims: ToolTokenClaims, x: number, y: number) => {
      calls.push(`move:${x}:${y}`);
    },
    drag: async (_claims: ToolTokenClaims, startX: number, startY: number, endX: number, endY: number) => {
      calls.push(`drag:${startX}:${startY}:${endX}:${endY}`);
    },
    type: async (_claims: ToolTokenClaims, text: string, delayMs: number) => {
      calls.push(`type:${text}:${delayMs}`);
    },
    key: async (_claims: ToolTokenClaims, key: string, modifiers: string[]) => {
      calls.push(`key:${modifiers.join("+")}:${key}`);
    },
    hotkey: async (_claims: ToolTokenClaims, keys: string) => {
      calls.push(`hotkey:${keys}`);
    },
    scroll: async (_claims: ToolTokenClaims, x: number, y: number, direction: string, amount: number) => {
      calls.push(`scroll:${x}:${y}:${direction}:${amount}`);
    },
  };
}

afterEach(() => setComputerUseServiceForTest(null));

describe("computer-use gateway tools", () => {
  test("maps provider-neutral key names to X11 keysyms", () => {
    expect(x11KeyName("ENTER")).toBe("Return");
    expect(x11KeyName("ArrowUp")).toBe("Up");
    expect(x11KeyName("Backspace")).toBe("BackSpace");
    expect(x11KeyName("l")).toBe("l");
    expect(x11KeyCommand("ENTER")).toBe(
      "xdotool keydown --clearmodifiers Return; sleep 0.1; xdotool keyup Return; sleep 0.2",
    );
    expect(x11KeyCommand("l", ["ctrl", "shift"])).toBe(
      "xdotool key --clearmodifiers --delay 100 ctrl+shift+l; sleep 0.2",
    );
  });

  test("advertises only explicit OS-level computer actions", () => {
    expect(COMPUTER_USE_TOOLS.map((tool) => tool.name)).toEqual([
      "computer_screenshot",
      "computer_click",
      "computer_move",
      "computer_drag",
      "computer_type",
      "computer_key",
      "computer_hotkey",
      "computer_scroll",
    ]);
    expect(COMPUTER_USE_TOOLS.map((tool) => tool.name).join(" ")).not.toContain("browser_");
  });

  test("returns a model-visible screenshot without implicitly publishing it", async () => {
    setComputerUseServiceForTest(testService([]));
    const response = await executeComputerUseTool(claims, "computer_screenshot", {});

    expect(response.isError).toBeUndefined();
    expect(response.content).toEqual([
      { type: "image", data: "cG5n", mimeType: "image/png" },
      { type: "text", text: "Desktop screenshot captured at /root/work/screenshots/proof.png." },
    ]);
    expect(response.structuredContent).toEqual({ path: "/root/work/screenshots/proof.png" });
  });

  test("validates and dispatches mouse and keyboard actions", async () => {
    const calls: string[] = [];
    setComputerUseServiceForTest(testService(calls));

    await executeComputerUseTool(claims, "computer_click", { x: 12, y: 34, button: "right", double: true });
    await executeComputerUseTool(claims, "computer_type", { text: "hello", delay_ms: 5 });
    await executeComputerUseTool(claims, "computer_key", { key: "l", modifiers: ["ctrl", "shift"] });
    await executeComputerUseTool(claims, "computer_scroll", { x: 40, y: 50, direction: "down", amount: 4 });

    expect(calls).toEqual([
      "click:12:34:right:true",
      "type:hello:5",
      "key:ctrl+shift:l",
      "scroll:40:50:down:4",
    ]);
  });

  test("rejects invalid buttons and modifiers before touching the sandbox", async () => {
    const calls: string[] = [];
    setComputerUseServiceForTest(testService(calls));

    const badButton = await executeComputerUseTool(claims, "computer_click", {
      x: 1,
      y: 2,
      button: "forward",
    });
    const badModifier = await executeComputerUseTool(claims, "computer_key", {
      key: "l",
      modifiers: ["meta; touch /tmp/pwned"],
    });

    expect(badButton).toMatchObject({ isError: true });
    expect(badButton.content[0]).toEqual({
      type: "text",
      text: "button must be left, middle, or right",
    });
    expect(badModifier).toMatchObject({ isError: true });
    expect(badModifier.content[0]).toEqual({
      type: "text",
      text: "modifiers must contain only ctrl, alt, shift, or cmd",
    });
    expect(calls).toEqual([]);
  });
});
