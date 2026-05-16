import { ensureSandboxDesktopView } from "../../engines/desktop";
import { getRunForOrg } from "../../runs/repo";
import {
  sandboxProvider,
  sandboxProviderApiKey,
  type SandboxHandle,
} from "../../sandboxes/provider";
import type { ToolTokenClaims } from "./token";

type ComputerToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };

interface ComputerToolResult {
  content: ComputerToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type Button = "left" | "middle" | "right";
type Direction = "up" | "down";

interface ComputerUseService {
  screenshot(claims: ToolTokenClaims): Promise<ComputerToolResult>;
  click(claims: ToolTokenClaims, x: number, y: number, button: Button, double: boolean): Promise<void>;
  move(claims: ToolTokenClaims, x: number, y: number): Promise<void>;
  drag(claims: ToolTokenClaims, startX: number, startY: number, endX: number, endY: number): Promise<void>;
  type(claims: ToolTokenClaims, text: string, delayMs: number): Promise<void>;
  key(claims: ToolTokenClaims, key: string, modifiers: string[]): Promise<void>;
  hotkey(claims: ToolTokenClaims, keys: string): Promise<void>;
  scroll(claims: ToolTokenClaims, x: number, y: number, direction: Direction, amount: number): Promise<void>;
}

const DISPLAY = ":1";
const MAX_COORDINATE = 10_000;
const MAX_TEXT_LENGTH = 20_000;
const KEY_RE = /^[A-Za-z0-9_+ -]{1,80}$/;
const BUTTONS = new Set<Button>(["left", "middle", "right"]);
const MODIFIERS = new Set(["ctrl", "alt", "shift", "cmd"]);

function result(text: string, structuredContent?: Record<string, unknown>): ComputerToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function failure(text: string): ComputerToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function integer(value: unknown, name: string, min = 0, max = MAX_COORDINATE): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

function string(value: unknown, name: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value;
}

function keyName(value: unknown, name = "key"): string {
  const key = string(value, name, 80);
  if (!KEY_RE.test(key)) throw new Error(`${name} contains unsupported characters`);
  return key;
}

const X11_KEY_ALIASES: Readonly<Record<string, string>> = {
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  backspace: "BackSpace",
  cmd: "Super_L",
  enter: "Return",
  esc: "Escape",
  escape: "Escape",
  pagedown: "Page_Down",
  pageup: "Page_Up",
  return: "Return",
  space: "space",
};

export function x11KeyName(key: string): string {
  return X11_KEY_ALIASES[key.toLowerCase()] ?? key;
}

export function x11KeyCommand(key: string, modifiers: readonly string[] = []): string {
  const normalizedKey = x11KeyName(key);
  if (modifiers.length === 0) {
    return `xdotool keydown --clearmodifiers ${normalizedKey}; sleep 0.1; xdotool keyup ${normalizedKey}; sleep 0.2`;
  }
  const chord = [...modifiers.map(x11KeyName), normalizedKey].join("+");
  return `xdotool key --clearmodifiers --delay 100 ${chord}; sleep 0.2`;
}

function x11Hotkey(keys: string): string {
  return keys
    .replaceAll(" ", "")
    .split("+")
    .map(x11KeyName)
    .join("+");
}

function buttonName(value: unknown): Button {
  const button = value ?? "left";
  if (typeof button !== "string" || !BUTTONS.has(button as Button)) {
    throw new Error("button must be left, middle, or right");
  }
  return button as Button;
}

function modifiers(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((modifier) => typeof modifier !== "string" || !MODIFIERS.has(modifier))) {
    throw new Error("modifiers must contain only ctrl, alt, shift, or cmd");
  }
  return value;
}

async function computerSandbox(claims: ToolTokenClaims): Promise<SandboxHandle> {
  const run = await getRunForOrg(claims.orgId, claims.runId);
  if (!run || run.threadId !== claims.threadId) throw new Error("run is not active in this thread");
  if (!run.sandboxId) throw new Error("no sandbox is attached to this run");
  const apiKey = sandboxProviderApiKey();
  if (apiKey === undefined) throw new Error("sandbox provider credentials are not set");
  return await sandboxProvider(apiKey).get(run.sandboxId);
}

async function readySandbox(claims: ToolTokenClaims): Promise<SandboxHandle> {
  const sandbox = await computerSandbox(claims);
  if (sandbox.computerUse) {
    await sandbox.computerUse.start();
    return sandbox;
  }
  const desktop = await ensureSandboxDesktopView(sandbox, AbortSignal.timeout(60_000));
  if (!desktop.available) throw new Error(desktop.reason ?? "desktop failed readiness");
  return sandbox;
}

async function cubeCommand(sandbox: SandboxHandle, command: string): Promise<string> {
  const executed = await sandbox.process.executeCommand(
    `export DISPLAY=${DISPLAY}; ${command}`,
    undefined,
    undefined,
    60,
  );
  if ((executed.exitCode ?? 1) !== 0) {
    throw new Error((executed.result ?? "computer-use command failed").trim());
  }
  return executed.result ?? "";
}

function buttonNumber(button: Button): number {
  return button === "left" ? 1 : button === "middle" ? 2 : 3;
}

async function screenshot(claims: ToolTokenClaims): Promise<ComputerToolResult> {
  const sandbox = await readySandbox(claims);
  const path = `${sandbox.computerUse ? "/home/daytona" : "/root"}/work/screenshots/screenshot-${Date.now()}.png`;
  let data: string;
  if (sandbox.computerUse) {
    const captured = await sandbox.computerUse.screenshot.takeFullScreen(true);
    data = (captured.screenshot ?? "").replace(/^data:image\/png;base64,/, "");
    if (!data) throw new Error("Daytona returned an empty screenshot");
    await cubeCommand(
      sandbox,
      `mkdir -p "$(dirname '${path}')"; printf '%s' '${data}' | base64 -d > '${path}'`,
    );
  } else {
    const output = await cubeCommand(
      sandbox,
      `mkdir -p "$(dirname '${path}')"; ` +
        `size=$(xdpyinfo -display ${DISPLAY} | awk '/dimensions:/{print $2; exit}'); ` +
        `ffmpeg -hide_banner -loglevel error -f x11grab -video_size "$size" -i ${DISPLAY} ` +
        `-frames:v 1 -y '${path}'; printf '__PATH__%s\\n' '${path}'; base64 -w0 '${path}'`,
    );
    const markerEnd = output.indexOf("\n");
    if (!output.startsWith("__PATH__") || markerEnd < 0) throw new Error("screenshot output was malformed");
    data = output.slice(markerEnd + 1).trim();
  }
  return {
    content: [
      { type: "image", data, mimeType: "image/png" },
      {
        type: "text",
        text: `Desktop screenshot captured at ${path}. Call artifact_publish only when the user needs this file.`,
      },
    ],
    structuredContent: { path },
  };
}

const productionService: ComputerUseService = {
  screenshot,
  async click(claims, x, y, button, double) {
    const sandbox = await readySandbox(claims);
    if (sandbox.computerUse) {
      await sandbox.computerUse.mouse.click(x, y, button, double);
      return;
    }
    await cubeCommand(sandbox, `xdotool mousemove ${x} ${y} click ${double ? "--repeat 2 --delay 100 " : ""}${buttonNumber(button)}`);
  },
  async move(claims, x, y) {
    const sandbox = await readySandbox(claims);
    if (sandbox.computerUse) await sandbox.computerUse.mouse.move(x, y);
    else await cubeCommand(sandbox, `xdotool mousemove ${x} ${y}`);
  },
  async drag(claims, startX, startY, endX, endY) {
    const sandbox = await readySandbox(claims);
    if (sandbox.computerUse) await sandbox.computerUse.mouse.drag(startX, startY, endX, endY);
    else await cubeCommand(sandbox, `xdotool mousemove ${startX} ${startY} mousedown 1 mousemove --sync ${endX} ${endY} mouseup 1`);
  },
  async type(claims, text, delayMs) {
    const sandbox = await readySandbox(claims);
    if (sandbox.computerUse) await sandbox.computerUse.keyboard.type(text, delayMs);
    else {
      const encoded = Buffer.from(text, "utf8").toString("base64");
      await cubeCommand(sandbox, `printf '%s' '${encoded}' | base64 -d | xdotool type --clearmodifiers --delay ${delayMs} --file -`);
    }
  },
  async key(claims, key, modifiers) {
    const sandbox = await readySandbox(claims);
    if (sandbox.computerUse) await sandbox.computerUse.keyboard.press(key, modifiers);
    else await cubeCommand(
      sandbox,
      x11KeyCommand(key, modifiers),
    );
  },
  async hotkey(claims, keys) {
    const sandbox = await readySandbox(claims);
    if (sandbox.computerUse) await sandbox.computerUse.keyboard.hotkey(keys);
    else await cubeCommand(sandbox, `xdotool key --clearmodifiers ${x11Hotkey(keys)}`);
  },
  async scroll(claims, x, y, direction, amount) {
    const sandbox = await readySandbox(claims);
    if (sandbox.computerUse) await sandbox.computerUse.mouse.scroll(x, y, direction, amount);
    else await cubeCommand(sandbox, `xdotool mousemove ${x} ${y} click --repeat ${amount} --delay 40 ${direction === "up" ? 4 : 5}`);
  },
};

let serviceOverride: ComputerUseService | null = null;

export function setComputerUseServiceForTest(service: ComputerUseService | null): void {
  serviceOverride = service;
}

export const COMPUTER_USE_TOOLS = [
  { name: "computer_screenshot", description: "Capture the current full desktop for model inspection without publishing a user-facing artifact. Always inspect this before and after coordinate actions. Use artifact_publish only when the user requests the screenshot file.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "computer_click", description: "Click an absolute desktop coordinate.", inputSchema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, button: { type: "string", enum: ["left", "middle", "right"] }, double: { type: "boolean" } }, required: ["x", "y"], additionalProperties: false } },
  { name: "computer_move", description: "Move the desktop pointer to an absolute coordinate.", inputSchema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"], additionalProperties: false } },
  { name: "computer_drag", description: "Drag with the left mouse button between absolute desktop coordinates.", inputSchema: { type: "object", properties: { start_x: { type: "integer" }, start_y: { type: "integer" }, end_x: { type: "integer" }, end_y: { type: "integer" } }, required: ["start_x", "start_y", "end_x", "end_y"], additionalProperties: false } },
  { name: "computer_type", description: "Type text into the currently focused desktop application.", inputSchema: { type: "object", properties: { text: { type: "string" }, delay_ms: { type: "integer", minimum: 0, maximum: 1000 } }, required: ["text"], additionalProperties: false } },
  { name: "computer_key", description: "Press one desktop key with optional modifiers.", inputSchema: { type: "object", properties: { key: { type: "string" }, modifiers: { type: "array", items: { type: "string", enum: ["ctrl", "alt", "shift", "cmd"] } } }, required: ["key"], additionalProperties: false } },
  { name: "computer_hotkey", description: "Press one atomic desktop hotkey chord such as ctrl+l or alt+tab.", inputSchema: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"], additionalProperties: false } },
  { name: "computer_scroll", description: "Scroll at an absolute desktop coordinate.", inputSchema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, direction: { type: "string", enum: ["up", "down"] }, amount: { type: "integer", minimum: 1, maximum: 100 } }, required: ["x", "y", "direction"], additionalProperties: false } },
] as const;

export const COMPUTER_USE_TOOL_NAMES: ReadonlySet<string> = new Set(COMPUTER_USE_TOOLS.map((tool) => tool.name));

export async function executeComputerUseTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ComputerToolResult> {
  const service = serviceOverride ?? productionService;
  try {
    if (name === "computer_screenshot") return await service.screenshot(claims);
    if (name === "computer_click") {
      await service.click(claims, integer(args.x, "x"), integer(args.y, "y"), buttonName(args.button), args.double === true);
    } else if (name === "computer_move") {
      await service.move(claims, integer(args.x, "x"), integer(args.y, "y"));
    } else if (name === "computer_drag") {
      await service.drag(claims, integer(args.start_x, "start_x"), integer(args.start_y, "start_y"), integer(args.end_x, "end_x"), integer(args.end_y, "end_y"));
    } else if (name === "computer_type") {
      await service.type(claims, string(args.text, "text"), integer(args.delay_ms ?? 10, "delay_ms", 0, 1000));
    } else if (name === "computer_key") {
      await service.key(claims, keyName(args.key), modifiers(args.modifiers));
    } else if (name === "computer_hotkey") {
      await service.hotkey(claims, keyName(args.keys, "keys"));
    } else if (name === "computer_scroll") {
      const direction = args.direction === "up" ? "up" : args.direction === "down" ? "down" : null;
      if (!direction) throw new Error("direction must be up or down");
      await service.scroll(claims, integer(args.x, "x"), integer(args.y, "y"), direction, integer(args.amount ?? 3, "amount", 1, 100));
    } else {
      return failure(`Unknown tool: ${name}`);
    }
    return result(`${name} completed`, { action: name });
  } catch (error) {
    return failure(error instanceof Error ? error.message : `${name} failed`);
  }
}
