import { ensureSandboxDesktopView } from "../../engines/desktop";
import { getRunForOrg } from "../../runs/repo";
import {
  sandboxProvider,
  sandboxProviderApiKey,
  type SandboxHandle,
} from "../../sandboxes/provider";
import { executeArtifactTool, type ToolResult } from "./artifact-tools";
import type { ToolTokenClaims } from "./token";

export type ComputerToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };

interface ComputerToolResult {
  content: ComputerToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type Button = "left" | "middle" | "right";
type Direction = "up" | "down";
export type ComputerSequenceAction =
  | { readonly action: "click"; readonly x: number; readonly y: number; readonly button: Button; readonly double: boolean }
  | { readonly action: "move"; readonly x: number; readonly y: number }
  | { readonly action: "drag"; readonly startX: number; readonly startY: number; readonly endX: number; readonly endY: number }
  | { readonly action: "type"; readonly text: string; readonly delayMs: number }
  | { readonly action: "key"; readonly key: string; readonly modifiers: readonly string[] }
  | { readonly action: "hotkey"; readonly keys: string }
  | { readonly action: "scroll"; readonly x: number; readonly y: number; readonly direction: Direction; readonly amount: number }
  | { readonly action: "wait"; readonly ms: number };

interface ComputerUseService {
  screenshot(claims: ToolTokenClaims): Promise<ComputerToolResult>;
  sequence(
    claims: ToolTokenClaims,
    actions: readonly ComputerSequenceAction[],
    captureScreenshot: boolean,
  ): Promise<ComputerToolResult | null>;
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
const MAX_SEQUENCE_ACTIONS = 8;
const MAX_SEQUENCE_TEXT_LENGTH = 2_000;
const MAX_SEQUENCE_WAIT_MS = 5_000;
const USER_REQUESTED_PROOF_PURPOSE = "user_requested_proof";

function result(text: string, structuredContent?: Record<string, unknown>): ComputerToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function sequenceActionNames(actions: readonly ComputerSequenceAction[]): string[] {
  return actions.map(({ action }) => action);
}

function sequenceReceipt(actionNames: readonly string[]): string {
  return `Computer sequence completed. Executed actions: ${actionNames.join(", ")}.`;
}

export function screenshotArtifactHandoff(path: string): string {
  return `Desktop screenshot captured at ${path}. This screenshot is private model inspection by default. ` +
    "If the user explicitly requested durable proof, call artifact_publish before responding with " +
    `path=${path} and purpose=user_requested_proof.`;
}

function withSequenceReceipt(
  captured: ComputerToolResult,
  actions: readonly ComputerSequenceAction[],
): ComputerToolResult {
  const actionNames = sequenceActionNames(actions);
  const receipt = sequenceReceipt(actionNames);
  const textIndex = captured.content.findIndex(({ type }) => type === "text");
  const existingText = textIndex >= 0 && captured.content[textIndex]!.type === "text"
    ? captured.content[textIndex]!.text
    : "";
  const content: ComputerToolContent[] = [
    {
      type: "text",
      text: `${receipt} ${existingText}`.trim(),
    },
    ...captured.content.filter((_, index) => index !== textIndex),
  ];
  return {
    ...captured,
    content,
    structuredContent: {
      ...(captured.structuredContent ?? {}),
      action: "computer_sequence",
      action_count: actions.length,
      executed_actions: actionNames,
    },
  };
}

function withPublishedProof(
  captured: ComputerToolResult,
  actions: readonly ComputerSequenceAction[],
  published: ToolResult,
): ComputerToolResult {
  const sequenced = withSequenceReceipt(captured, actions);
  const proofText = published.content.map(({ text }) => text).join("\n");
  const textIndex = sequenced.content.findIndex(({ type }) => type === "text");
  const existingText = textIndex >= 0 && sequenced.content[textIndex]!.type === "text"
    ? sequenced.content[textIndex]!.text
    : "";
  const content: ComputerToolContent[] = [
    {
      type: "text",
      text: `${existingText}\n${proofText}`.trim(),
    },
    ...sequenced.content.filter((_, index) => index !== textIndex),
  ];
  return {
    content,
    structuredContent: {
      ...(sequenced.structuredContent ?? {}),
      ...(published.structuredContent ?? {}),
      proof_published: published.isError !== true,
    },
    ...(published.isError ? { isError: true } : {}),
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
  return x11ChordCommand(normalizedKey, modifiers.map(x11KeyName));
}

function x11ChordCommand(key: string, modifiers: readonly string[]): string {
  const press = [
    "xdotool keyup ctrl alt shift Super_L",
    "sleep 0.05",
    ...modifiers.map((modifier) => `xdotool keydown ${modifier}`),
    `xdotool key ${key}`,
  ].join(" && ");
  const up = [...modifiers].reverse().map((modifier) => `xdotool keyup ${modifier}`).join("; ");
  return `${press}; status=$?; ${up}; sleep 0.2; test $status -eq 0`;
}

export function x11HotkeyCommand(keys: string): string {
  const parts = keys
    .replaceAll(" ", "")
    .split("+")
    .map(x11KeyName);
  const key = parts.at(-1);
  if (!key) throw new Error("hotkey must contain a key");
  return parts.length === 1
    ? x11KeyCommand(key)
    : x11ChordCommand(key, parts.slice(0, -1));
}

function buttonName(value: unknown): Button {
  const button = value ?? "left";
  if (typeof button !== "string" || !BUTTONS.has(button as Button)) {
    throw new Error("button must be left, middle, or right");
  }
  return button as Button;
}

function scrollDirection(value: unknown, name: string): Direction {
  if (value === "up" || value === "down") return value;
  throw new Error(`${name} must be up or down`);
}

function modifiers(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((modifier) => typeof modifier !== "string" || !MODIFIERS.has(modifier))) {
    throw new Error("modifiers must contain only ctrl, alt, shift, or cmd");
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseSequenceAction(value: unknown, index: number): ComputerSequenceAction {
  const action = record(value, `actions[${index}]`);
  const kind = action.action;
  if (typeof kind !== "string") throw new Error(`actions[${index}].action must be a string`);
  switch (kind) {
    case "click":
      return {
        action: "click",
        x: integer(action.x, `actions[${index}].x`),
        y: integer(action.y, `actions[${index}].y`),
        button: buttonName(action.button),
        double: action.double === true,
      };
    case "move":
      return {
        action: "move",
        x: integer(action.x, `actions[${index}].x`),
        y: integer(action.y, `actions[${index}].y`),
      };
    case "drag":
      return {
        action: "drag",
        startX: integer(action.start_x, `actions[${index}].start_x`),
        startY: integer(action.start_y, `actions[${index}].start_y`),
        endX: integer(action.end_x, `actions[${index}].end_x`),
        endY: integer(action.end_y, `actions[${index}].end_y`),
      };
    case "type":
      return {
        action: "type",
        text: string(action.text, `actions[${index}].text`, MAX_SEQUENCE_TEXT_LENGTH),
        delayMs: integer(action.delay_ms ?? 10, `actions[${index}].delay_ms`, 0, 1000),
      };
    case "key":
      return {
        action: "key",
        key: keyName(action.key, `actions[${index}].key`),
        modifiers: modifiers(action.modifiers),
      };
    case "hotkey":
      return {
        action: "hotkey",
        keys: keyName(action.keys, `actions[${index}].keys`),
      };
    case "scroll": {
      return {
        action: "scroll",
        x: integer(action.x, `actions[${index}].x`),
        y: integer(action.y, `actions[${index}].y`),
        direction: scrollDirection(action.direction, `actions[${index}].direction`),
        amount: integer(action.amount ?? 3, `actions[${index}].amount`, 1, 100),
      };
    }
    case "wait":
      return {
        action: "wait",
        ms: integer(action.ms ?? 250, `actions[${index}].ms`, 0, MAX_SEQUENCE_WAIT_MS),
      };
    default:
      throw new Error(`actions[${index}].action must be one of click, move, drag, type, key, hotkey, scroll, wait`);
  }
}

function sequenceActions(value: unknown): ComputerSequenceAction[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SEQUENCE_ACTIONS) {
    throw new Error(`actions must contain 1 to ${MAX_SEQUENCE_ACTIONS} items`);
  }
  return value.map(parseSequenceAction);
}

function sequenceRequestedProof(args: Record<string, unknown>): boolean {
  if (args.publish_screenshot !== true) return false;
  if (args.screenshot !== true) throw new Error("publish_screenshot requires screenshot=true");
  if (args.purpose !== USER_REQUESTED_PROOF_PURPOSE) {
    throw new Error("publish_screenshot requires purpose=user_requested_proof");
  }
  return true;
}

function capturedScreenshotPath(captured: ComputerToolResult): string {
  const path = captured.structuredContent?.path;
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("publish_screenshot requires a captured screenshot path");
  }
  return path.trim();
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
    throw new Error(
      (executed.result ?? "computer-use command failed; the desktop may still be starting - retry once").trim(),
    );
  }
  return executed.result ?? "";
}

function cubeSequenceCommand(action: ComputerSequenceAction): string {
  switch (action.action) {
    case "click":
      return `xdotool mousemove ${action.x} ${action.y} click ${
        action.double ? "--repeat 2 --delay 100 " : ""
      }${buttonNumber(action.button)}`;
    case "move":
      return `xdotool mousemove ${action.x} ${action.y}`;
    case "drag":
      return `xdotool mousemove ${action.startX} ${action.startY} mousedown 1 ` +
        `mousemove --sync ${action.endX} ${action.endY} mouseup 1`;
    case "type": {
      const encoded = Buffer.from(action.text, "utf8").toString("base64");
      return `printf '%s' '${encoded}' | base64 -d | ` +
        `xdotool type --clearmodifiers --delay ${action.delayMs} --file -`;
    }
    case "key":
      return x11KeyCommand(action.key, action.modifiers);
    case "hotkey":
      return x11HotkeyCommand(action.keys);
    case "scroll":
      return `xdotool mousemove ${action.x} ${action.y} click --repeat ${action.amount} ` +
        `--delay 40 ${action.direction === "up" ? 4 : 5}`;
    case "wait":
      return `sleep ${(action.ms / 1000).toFixed(3)}`;
  }
}

export function buildCubeSequenceCommand(
  actions: readonly ComputerSequenceAction[],
): string {
  return actions.map(cubeSequenceCommand).join(" && ");
}

async function executeNativeSequenceAction(
  sandbox: SandboxHandle,
  action: ComputerSequenceAction,
): Promise<void> {
  const computerUse = sandbox.computerUse;
  if (!computerUse) {
    throw new Error(
      "native computer use is unavailable in this sandbox; retry the run, and report it if the task requires the desktop",
    );
  }
  switch (action.action) {
    case "click":
      await computerUse.mouse.click(action.x, action.y, action.button, action.double);
      return;
    case "move":
      await computerUse.mouse.move(action.x, action.y);
      return;
    case "drag":
      await computerUse.mouse.drag(action.startX, action.startY, action.endX, action.endY);
      return;
    case "type":
      await computerUse.keyboard.type(action.text, action.delayMs);
      return;
    case "key":
      await computerUse.keyboard.press(action.key, [...action.modifiers]);
      return;
    case "hotkey":
      await computerUse.keyboard.hotkey(action.keys);
      return;
    case "scroll":
      await computerUse.mouse.scroll(action.x, action.y, action.direction, action.amount);
      return;
    case "wait":
      await Bun.sleep(action.ms);
  }
}

function buttonNumber(button: Button): number {
  switch (button) {
    case "left":
      return 1;
    case "middle":
      return 2;
    case "right":
      return 3;
  }
}

async function captureSandboxScreenshot(sandbox: SandboxHandle): Promise<ComputerToolResult> {
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
        text: screenshotArtifactHandoff(path),
      },
    ],
    structuredContent: { path },
  };
}

async function screenshot(claims: ToolTokenClaims): Promise<ComputerToolResult> {
  return await captureSandboxScreenshot(await readySandbox(claims));
}

const productionService: ComputerUseService = {
  screenshot,
  async sequence(claims, actions, captureScreenshot) {
    const sandbox = await readySandbox(claims);
    if (sandbox.computerUse) {
      for (const action of actions) await executeNativeSequenceAction(sandbox, action);
    } else {
      await cubeCommand(sandbox, buildCubeSequenceCommand(actions));
    }
    return captureScreenshot ? await captureSandboxScreenshot(sandbox) : null;
  },
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
    else await cubeCommand(sandbox, x11HotkeyCommand(keys));
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
  {
    name: "computer_screenshot",
    description:
      "Capture the current full desktop for private model inspection without publishing a user-facing artifact. Use it for the initial state and after an uncertain or failed transition. For predictable follow-up actions, prefer one computer_sequence with screenshot=true instead of alternating screenshots and single actions. Use artifact_publish only when the user requests the file.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "computer_sequence",
    description:
      "Primary desktop action tool. Run 1-8 OS-level actions in one ordered batch and optionally return one private post-sequence screenshot. Batch every predictable action chain, including click+type+submit and focus+hotkey+type+key, instead of issuing atomic calls. Stop the batch at the first point that genuinely needs new visual inspection. Actions support click, move, drag, type, key, hotkey, scroll, and wait.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SEQUENCE_ACTIONS,
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["click", "move", "drag", "type", "key", "hotkey", "scroll", "wait"],
              },
              x: { type: "integer" },
              y: { type: "integer" },
              start_x: { type: "integer" },
              start_y: { type: "integer" },
              end_x: { type: "integer" },
              end_y: { type: "integer" },
              button: { type: "string", enum: ["left", "middle", "right"] },
              double: { type: "boolean" },
              text: { type: "string" },
              delay_ms: { type: "integer", minimum: 0, maximum: 1000 },
              key: { type: "string" },
              keys: { type: "string" },
              modifiers: {
                type: "array",
                items: { type: "string", enum: ["ctrl", "alt", "shift", "cmd"] },
              },
              direction: { type: "string", enum: ["up", "down"] },
              amount: { type: "integer", minimum: 1, maximum: 100 },
              ms: { type: "integer", minimum: 0, maximum: MAX_SEQUENCE_WAIT_MS },
            },
            required: ["action"],
            additionalProperties: false,
          },
        },
        screenshot: { type: "boolean" },
        publish_screenshot: {
          type: "boolean",
          description:
            "Only set true when the user explicitly requested durable desktop proof. Requires screenshot=true and purpose=user_requested_proof; publishes only the post-sequence screenshot.",
        },
        purpose: {
          type: "string",
          enum: [USER_REQUESTED_PROOF_PURPOSE],
          description: "Required as user_requested_proof when publish_screenshot=true.",
        },
      },
      required: ["actions"],
      additionalProperties: false,
    },
  },
] as const;

const LEGACY_ATOMIC_COMPUTER_TOOL_NAMES = [
  "computer_click",
  "computer_move",
  "computer_drag",
  "computer_type",
  "computer_key",
  "computer_hotkey",
  "computer_scroll",
] as const;

export const COMPUTER_USE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...COMPUTER_USE_TOOLS.map((tool) => tool.name),
  ...LEGACY_ATOMIC_COMPUTER_TOOL_NAMES,
]);

export async function executeComputerUseTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ComputerToolResult> {
  const service = serviceOverride ?? productionService;
  try {
    if (name === "computer_screenshot") return await service.screenshot(claims);
    if (name === "computer_sequence") {
      const actions = sequenceActions(args.actions);
      const publishProof = sequenceRequestedProof(args);
      const captured = await service.sequence(claims, actions, args.screenshot === true);
      if (publishProof) {
        if (!captured) throw new Error("publish_screenshot requires a captured screenshot path");
        const published = await executeArtifactTool(claims, "artifact_publish", {
          path: capturedScreenshotPath(captured),
          purpose: USER_REQUESTED_PROOF_PURPOSE,
        });
        return withPublishedProof(captured, actions, published);
      }
      if (captured) return withSequenceReceipt(captured, actions);
      const actionNames = sequenceActionNames(actions);
      return result(sequenceReceipt(actionNames), {
        action: name,
        action_count: actions.length,
        executed_actions: actionNames,
      });
    }
    switch (name) {
      case "computer_click":
        await service.click(claims, integer(args.x, "x"), integer(args.y, "y"), buttonName(args.button), args.double === true);
        break;
      case "computer_move":
        await service.move(claims, integer(args.x, "x"), integer(args.y, "y"));
        break;
      case "computer_drag":
        await service.drag(claims, integer(args.start_x, "start_x"), integer(args.start_y, "start_y"), integer(args.end_x, "end_x"), integer(args.end_y, "end_y"));
        break;
      case "computer_type":
        await service.type(claims, string(args.text, "text"), integer(args.delay_ms ?? 10, "delay_ms", 0, 1000));
        break;
      case "computer_key":
        await service.key(claims, keyName(args.key), modifiers(args.modifiers));
        break;
      case "computer_hotkey":
        await service.hotkey(claims, keyName(args.keys, "keys"));
        break;
      case "computer_scroll":
        await service.scroll(
          claims,
          integer(args.x, "x"),
          integer(args.y, "y"),
          scrollDirection(args.direction, "direction"),
          integer(args.amount ?? 3, "amount", 1, 100),
        );
        break;
      default:
        return failure(`Unknown tool: ${name}`);
    }
    return result(`${name} completed`, { action: name });
  } catch (error) {
    return failure(error instanceof Error ? error.message : `${name} failed`);
  }
}
