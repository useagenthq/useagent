// Bot export and import, mounted under happy-dom with the real helpers over a
// stubbed fetch: Export bot downloads GET /api/bots/:id/export as a readable
// file; Import from file reads a chosen file; the import step shows what it
// holds, posts it to /api/bots/import under the name in the field, and either
// opens the new bot or first says what the import left out. The import step is
// mounted in the dialog's Root without its Content (no portal), as
// skill-delete-action.interaction.test does.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pushed: string[] = [];
let refreshes = 0;
mock.module("next/navigation", () => ({
  useRouter: () => ({
    replace: () => {},
    push: (path: string) => pushed.push(path),
    refresh: () => {
      refreshes += 1;
    },
  }),
  usePathname: () => "/bots",
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const Modal = await import("@/components/base/modal/modal");
const { readBotFile } = await import("./bot-file");
const { ExportBotSection, ImportBotPanel, ImportFromFileButton } = await import(
  "./bot-file-actions"
);
const { makeBot } = await import("./bot-fixture");

const FILE = {
  format: "useagent.bot",
  version: 1,
  bot: {
    name: "Ledger",
    title: "Data analyst",
    rules: "Numbers come from the warehouse.",
    engine: "codex",
    repos: ["acme/app"],
    avatarTone: "violet",
    avatarIcon: "code",
  },
  routines: [
    { name: "Weekly metrics", cron: "0 7 * * 1", timezone: "UTC", prompt: "Build the workbook." },
  ],
};

const originalFetch = globalThis.fetch;
let calls: { path: string; method: string; body: unknown }[] = [];
let importReplies: (() => Response)[] = [];

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
  await flush();
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

async function click(label: string) {
  await act(async () => {
    button(label).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function chooseFile(content: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  const file = new window.File([content], "ledger.bot.json", { type: "application/json" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await flush();
  await flush();
}

function nameField(): HTMLInputElement {
  const input = [...document.querySelectorAll<HTMLInputElement>("input")].find(
    (i) => i.placeholder === "Bot name",
  );
  if (!input) throw new Error("no name field");
  return input;
}

async function type(value: string) {
  const input = nameField();
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

const imports = () => calls.filter((call) => call.path === "/api/bots/import");
const created = (skipped = { repos: [] as string[], model: null as string | null }) =>
  Response.json(
    { bot: makeBot({ id: "b-new", name: "Ledger" }), routines: 1, skipped },
    { status: 201 },
  );

beforeEach(() => {
  calls = [];
  pushed.length = 0;
  refreshes = 0;
  importReplies = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({
      path: url.pathname,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (url.pathname === "/api/bots/b1/export") return Response.json(FILE);
    if (url.pathname === "/api/bots/import") return (importReplies.shift() ?? created)();
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
});

describe("bot export", () => {
  test("Export bot downloads the bot file under the bot's name", async () => {
    const createObjectURL = URL.createObjectURL;
    const blobs: Blob[] = [];
    const downloads: string[] = [];
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:bot";
    };
    const click = window.HTMLAnchorElement.prototype.click;
    window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    };
    try {
      await mount(<ExportBotSection bot={makeBot({ id: "b1", name: "Ledger" })} />);
      await clickExport();
      expect(calls.map((call) => call.path)).toEqual(["/api/bots/b1/export"]);
      expect(downloads).toEqual(["ledger.bot.json"]);
      expect(blobs[0]?.type).toBe("application/json;charset=utf-8");
      const text = await blobs[0]?.text();
      expect(text).toBe(`${JSON.stringify(FILE, null, 2)}\n`);
      expect(container?.querySelector('[role="alert"]')).toBeNull();
    } finally {
      URL.createObjectURL = createObjectURL;
      window.HTMLAnchorElement.prototype.click = click;
    }
  });

  test("a failed export says so beside the button", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: "not_found" }, { status: 404 })) as unknown as typeof fetch;
    await mount(<ExportBotSection bot={makeBot({ id: "b1" })} />);
    await clickExport();
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe("not_found");
  });
});

async function clickExport() {
  await click("Export bot");
  await flush();
}

function draft() {
  const read = readBotFile(JSON.stringify(FILE));
  if ("error" in read) throw new Error(read.error);
  return read.draft;
}

async function mountPanel(onBack: () => void = () => {}) {
  const closed: boolean[] = [];
  await mount(
    <Modal.Root open>
      <ImportBotPanel draft={draft()} onBack={onBack} onClose={() => closed.push(true)} />
    </Modal.Root>,
  );
  return closed;
}

describe("import from file", () => {
  test("a chosen bot file opens the import step with what it holds", async () => {
    const opened: unknown[] = [];
    const errors: string[] = [];
    await mount(
      <ImportFromFileButton
        onOpen={(next) => opened.push(next)}
        onError={(message) => errors.push(message)}
      />,
    );
    await chooseFile(JSON.stringify(FILE));
    expect(opened).toEqual([draft()]);
    expect(errors).toEqual([]);
  });

  test("a file that is not a bot file says why and opens nothing", async () => {
    const opened: unknown[] = [];
    const errors: string[] = [];
    await mount(
      <ImportFromFileButton
        onOpen={(next) => opened.push(next)}
        onError={(message) => errors.push(message)}
      />,
    );
    await chooseFile("name: Ledger");
    expect(opened).toEqual([]);
    expect(errors).toEqual(["This file is not a bot file. Choose a file made with Export bot."]);
  });
});

describe("bot import", () => {
  test("shows what the file holds and imports under the name in the field", async () => {
    const closed = await mountPanel();
    expect(nameField().value).toBe("Ledger");
    expect(document.body.textContent).toContain("Data analyst");
    expect(document.body.textContent).toContain("Codex");
    expect(document.body.textContent).toContain("acme/app");
    expect(document.body.textContent).toContain("1 routine, imported turned off.");

    await click("Import bot");
    expect(imports()).toEqual([{ path: "/api/bots/import", method: "POST", body: FILE }]);
    expect(pushed).toEqual(["/bots/b-new"]);
    expect(closed).toEqual([true]);
  });

  test("a taken name shows under the field, and the retry sends the new name", async () => {
    importReplies = [
      () =>
        Response.json(
          {
            error: "invalid_bot",
            field: "name",
            reason: "A bot named Ledger already exists. Choose another name.",
          },
          { status: 409 },
        ),
    ];
    await mountPanel();
    await click("Import bot");
    expect(document.body.textContent).toContain(
      "A bot named Ledger already exists. Choose another name.",
    );
    expect(nameField().getAttribute("aria-invalid")).toBe("true");
    expect(pushed).toEqual([]);

    await type("Ledger 2");
    await click("Import bot");
    expect(imports().map((call) => (call.body as { bot: { name: string } }).bot.name)).toEqual([
      "Ledger",
      "Ledger 2",
    ]);
    expect(pushed).toEqual(["/bots/b-new"]);
  });

  test("a refusal about the file shows as the panel's error", async () => {
    importReplies = [
      () =>
        Response.json(
          {
            error: "invalid_bot_file",
            field: "routines[0].cron",
            reason: "Weekly metrics needs a valid 5-field cron schedule",
          },
          { status: 400 },
        ),
    ];
    await mountPanel();
    await click("Import bot");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Weekly metrics needs a valid 5-field cron schedule",
    );
    expect(nameField().getAttribute("aria-invalid")).not.toBe("true");
    expect(pushed).toEqual([]);
  });

  test("a file over the size limit says so in plain words", async () => {
    importReplies = [() => Response.json({ error: "request_too_large" }, { status: 413 })];
    await mountPanel();
    await click("Import bot");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "This bot file is too large to import.",
    );
  });

  test("what the import left out is said before the bot opens", async () => {
    importReplies = [() => created({ repos: ["acme/app"], model: null })];
    await mountPanel();
    await click("Import bot");
    expect(document.body.textContent).toContain("Ledger is ready.");
    expect(document.body.textContent).toContain(
      "This repository was left out because this workspace can't reach it: acme/app.",
    );
    expect(pushed).toEqual([]);
    // The roster already shows the new bot if the dialog is closed here.
    expect(refreshes).toBe(1);
    await click("Open bot");
    expect(pushed).toEqual(["/bots/b-new"]);
  });

  test("Back leaves the import step without importing", async () => {
    let back = 0;
    await mountPanel(() => {
      back += 1;
    });
    await click("Back");
    expect(back).toBe(1);
    expect(imports()).toEqual([]);
  });
});
