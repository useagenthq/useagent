// Sending diff comments into a reply the user is half way through writing: the
// real Diff pane and the real reply composer in a live DOM, wired through the
// composer prefill the way the session view wires them.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, useCallback, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("@/components/chat/composer");
const { ComposerPrefillProvider } = await import("@/components/chat/composer-prefill-context");
const { DiffPane } = await import("@/components/chat/diff-pane");
import type { ComposerPrefill, PrefillComposer } from "@/components/chat/composer-prefill-context";
import type { ApiStep } from "@/components/chat/types";

const PATCH_STEP: ApiStep = {
  id: "step-review",
  run_id: "run-review",
  idx: 1,
  kind: "file",
  label: "routes.ts",
  chip: "file",
  code_json: JSON.stringify({
    tool: "patch",
    input: {
      filePath: "src/routes.ts",
      patch: "--- a/src/routes.ts\n+++ b/src/routes.ts\n@@ -1,2 +1,2 @@\n context\n-old line\n+new line",
    },
  }),
  created_at: "2026-08-17T00:00:00.000Z",
};

const DRAFT_KEY = "useagent.draft.run-review";

/** SessionView's prefill state, without the rest of the session, plus the
 *  plain prefill a conflicted proposal's "Ask agent to redo" sends. */
function Session() {
  const [prefill, setPrefill] = useState<ComposerPrefill | null>(null);
  const prefillComposer = useCallback<PrefillComposer>((text, options) => {
    setPrefill((prev) => ({ text, append: options?.append, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  return (
    <ComposerPrefillProvider value={prefillComposer}>
      <DiffPane turns={[{ run: { thread_id: "thread-review" }, steps: [PATCH_STEP], live: false }]} />
      <button type="button" onClick={() => prefillComposer("Redo the proposal")}>
        Ask agent to redo
      </button>
      <div data-testid="reply">
        <Composer
          variant="compact"
          enableModelPicker={false}
          draftKey="run-review"
          prefill={prefill}
          onSubmit={async () => {}}
        />
      </div>
    </ComposerPrefillProvider>
  );
}

function type(field: HTMLTextAreaElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Session />));
  const reply = host.querySelector<HTMLTextAreaElement>('[data-testid="reply"] textarea');
  if (!reply) throw new Error("no reply box");
  await act(async () => type(reply, "Also rename the helper"));
  return { host, root, reply };
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

// The composer asks the backend for its capability catalog on mount; there is
// no backend here, so it hears "not found" and keeps its defaults.
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
  window.localStorage.clear();
});

test("Send comments adds the review under a half-written reply instead of replacing it", async () => {
  const { host, root, reply } = await mount();
  const row = host.querySelector<HTMLElement>('[aria-label="Removed line 2: old line"]');
  if (!row) throw new Error("no diff row");
  await act(async () => {
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  const form = host.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Comment on"]');
  if (!form) throw new Error("no comment form");
  await act(async () => type(form, "Keep the old name"));
  await act(async () => button(host, "Add comment").click());
  await act(async () => button(host, "Send comments").click());

  expect(reply.value).toStartWith("Also rename the helper\n\nI left a comment on your changes.");
  expect(reply.value).toContain("Keep the old name");
  expect(window.localStorage.getItem(DRAFT_KEY)).toBe(reply.value);
  expect(host.querySelector('[data-testid="diff-review-bar"]')).toBeNull();

  await act(async () => root.unmount());
});

test("Ask agent to redo still replaces the draft", async () => {
  const { host, root, reply } = await mount();
  await act(async () => button(host, "Ask agent to redo").click());

  expect(reply.value).toBe("Redo the proposal");
  expect(window.localStorage.getItem(DRAFT_KEY)).toBe("Redo the proposal");

  await act(async () => root.unmount());
});
