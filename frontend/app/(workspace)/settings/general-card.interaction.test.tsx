// The Workspace name row in Settings, General, mounted under happy-dom beside
// the user menu, with the real team-api and auth helpers over a stubbed fetch:
// an owner's Save sends the trimmed name to the organisation update route, the
// row keeps the new name, and the user menu reads the workspace list again
// without a reload; a refusal shows the server's own words under the field.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { GeneralCard } = await import("./general-card");
const { UserMenu } = await import("@/components/shell/user-menu");

const originalFetch = globalThis.fetch;
let calls: { path: string; method: string; body: unknown }[] = [];
let workspaceName = "Ada's workspace";
let updateReply: () => Response = () => Response.json({ id: "org-1", name: workspaceName });
/** Holds the rename's answer until the test lets it go. */
let updateGate: Promise<void> = Promise.resolve();

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(role: "owner" | "admin" | "member") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <>
        <UserMenu />
        <GeneralCard initialWorkspace={{ id: "org-1", name: workspaceName, role }} />
      </>,
    );
  });
  await flush();
}

function field(): HTMLInputElement {
  const input = container?.querySelector<HTMLInputElement>('input[aria-label="Workspace name"]');
  if (!input) throw new Error("no Workspace name field");
  return input;
}

/** The form's submit button, labelled Save, or Saving... while a rename is in flight. */
function saveButton(): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>('form button[type="submit"]');
  if (!button) throw new Error("no Save button");
  return button;
}

async function type(value: string) {
  const input = field();
  await act(async () => {
    // React tracks the value it last rendered: go through the native setter so
    // the input event reads as a change.
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

async function save() {
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

const workspaceReads = () => calls.filter((call) => call.path === "/api/team/workspaces").length;

beforeEach(() => {
  calls = [];
  workspaceName = "Ada's workspace";
  updateReply = () => Response.json({ id: "org-1", name: workspaceName });
  updateGate = Promise.resolve();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    if (path === "/api/auth/get-session") {
      return Response.json({
        user: { id: "u1", name: "Ada", email: "ada@example.test", image: null },
        session: { activeOrganizationId: "org-1" },
      });
    }
    if (path === "/api/team/workspaces") {
      return Response.json({
        activeOrganizationId: "org-1",
        workspaces: [{ id: "org-1", name: workspaceName, role: "owner", members: 2 }],
      });
    }
    if (path === "/api/auth/organization/update") {
      await updateGate;
      const reply = updateReply();
      if (reply.ok) workspaceName = (body as { data: { name: string } }).data.name;
      return reply;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  globalThis.fetch = originalFetch;
});

describe("renaming the workspace from Settings", () => {
  test("an owner saves the trimmed name, the row keeps it, and the user menu reads the list again", async () => {
    await mount("owner");
    expect(field().value).toBe("Ada's workspace");
    expect(saveButton().textContent).toBe("Save");
    expect(saveButton().disabled).toBe(true);
    const readsBefore = workspaceReads();
    expect(readsBefore).toBeGreaterThan(0);

    await type("  Acme Robotics  ");
    expect(saveButton().disabled).toBe(false);
    await save();

    const update = calls.find((call) => call.path === "/api/auth/organization/update");
    expect(update?.method).toBe("POST");
    expect(update?.body).toEqual({ organizationId: "org-1", data: { name: "Acme Robotics" } });
    expect(container?.querySelector('[role="status"]')?.textContent).toBe("Saved.");
    expect(field().value).toBe("Acme Robotics");
    // The saved name is now the row's own: Save stays off until it changes again.
    expect(saveButton().disabled).toBe(true);
    // The user menu asked for the workspace list again, and got the new name.
    expect(workspaceReads()).toBe(readsBefore + 1);
  });

  test("an admin who is refused sees the server's reason under the field", async () => {
    updateReply = () =>
      Response.json(
        { message: "You are not allowed to update this organization" },
        { status: 403 },
      );
    await mount("admin");
    const readsBefore = workspaceReads();

    await type("Acme Robotics");
    await save();

    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("You are not allowed to update this organization");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("aria-describedby")).toContain(alert?.id ?? "missing");
    expect(container?.querySelector('[role="status"]')).toBeNull();
    expect(field().value).toBe("Acme Robotics");
    // Nothing changed, so nothing reads the list again.
    expect(workspaceReads()).toBe(readsBefore);
  });

  test("text typed while the save is in flight stays in the field, without Saved beside it", async () => {
    let release = () => {};
    updateGate = new Promise((resolve) => {
      release = resolve;
    });
    await mount("owner");
    await type("Acme Robotics");
    await save();
    expect(saveButton().textContent).toContain("Saving...");

    await type("Acme Robotics Ltd");
    await act(async () => {
      release();
    });
    await flush();

    expect(field().value).toBe("Acme Robotics Ltd");
    expect(container?.querySelector('[role="status"]')).toBeNull();
    // Measured against the name just saved, the new text can be saved in turn.
    expect(saveButton().disabled).toBe(false);
  });

  test("a blank or unchanged name is never sent", async () => {
    await mount("owner");
    await type("   ");
    expect(saveButton().disabled).toBe(true);
    await type(" Ada's workspace ");
    expect(saveButton().disabled).toBe(true);
    expect(calls.some((call) => call.path === "/api/auth/organization/update")).toBe(false);
  });

  test("a member gets the name as text, with nothing to edit", async () => {
    await mount("member");
    expect(container?.querySelector('input[aria-label="Workspace name"]')).toBeNull();
    expect(container?.textContent).toContain("Ada's workspace");
  });
});
