import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ArtifactDescriptor } from "@useagent/agent-client";
import {
  contentTypeForName,
  DEFAULT_DOCUMENT_THEME,
  DOCUMENT_SCHEMA_VERSION,
} from "@useagent/artifact-workspace";
import { act } from "react";
import { useWorkpieceEditor, type WorkpieceEditorController } from "./artifact-editor-state";

// Drives the real editor hook through a save whose PATCH is still in flight while
// the member keeps typing. Only the transport is faked: fetch and EventSource.
const HEX = "a".repeat(64);
type Patch = { readonly expected_revision: number; readonly state: Record<string, unknown> };

function descriptor(name: string, revision: number): ArtifactDescriptor {
  return {
    id: "doc-1",
    run_id: "run-1",
    thread_id: "thread-1",
    name,
    source_path: name,
    content_type: contentTypeForName(name),
    size_bytes: 64,
    sha256: HEX,
    created_at: "2026-11-05T00:00:00.000Z",
    preview_url: "/api/artifacts/doc-1/preview",
    download_url: "/api/artifacts/doc-1/download",
    preview_pdf_url: null,
    workpiece: {
      kind: "document",
      source_version: HEX,
      state_revision: revision,
      state_url: "/api/artifacts/doc-1/state",
      actions: ["preview", "download", "edit"],
    },
  } as ArtifactDescriptor;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class SilentEventSource extends EventTarget {
  close(): void {}
}

const waitFor = async (check: () => boolean) => {
  for (let tries = 0; tries < 100 && !check(); tries++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  expect(check()).toBe(true);
};

if (typeof window === "undefined") GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

const originalFetch = globalThis.fetch;
const globals = globalThis as { EventSource?: unknown };
const originalEventSource = globals.EventSource;
beforeAll(() => {
  // happy-dom has no EventSource; the editor's org-change subscription opens one.
  globals.EventSource = SilentEventSource;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  globals.EventSource = originalEventSource;
});

/** Mounts the auto-saving editor over a fake backend whose PATCHes resolve only
 * when the test says so, returning handles to type, inspect and release them. */
async function mountEditor(name: string, initialState: Record<string, unknown>) {
  const patches: Patch[] = [];
  const pending: ((response: Response) => void)[] = [];
  let revision = 1;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "PATCH") {
      return json({ workpiece: descriptor(name, revision).workpiece, state: initialState });
    }
    patches.push(JSON.parse(String(init.body)) as Patch);
    const { promise, resolve } = Promise.withResolvers<Response>();
    pending.push(resolve);
    return promise;
  }) as typeof fetch;

  // One stable descriptor, as a mounted pane holds it: a new object per render
  // would re-run the load effect.
  const artifact = descriptor(name, 1);
  const ref: { current: WorkpieceEditorController | null } = { current: null };
  function Probe() {
    const editor = useWorkpieceEditor(artifact, { autosave: true });
    ref.current = editor;
    return editor.isRich ? <div ref={editor.richEditorRef} /> : null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  const editor = () => {
    if (!ref.current) throw new Error("editor not mounted");
    return ref.current;
  };
  await waitFor(() => !editor().loading);

  /** Answers the oldest pending PATCH with the next saved revision. */
  const resolveSave = async () => {
    revision += 1;
    const body = patches[patches.length - pending.length];
    await act(async () => {
      pending.shift()?.(
        json({ workpiece: descriptor(name, revision).workpiece, state: body?.state }),
      );
    });
  };
  return { editor, patches, resolveSave, unmount: () => act(() => root.unmount()) };
}

describe("a save in flight keeps what the member typed meanwhile", () => {
  test("text: newer typing survives the save and is the next autosave", async () => {
    const { editor, patches, resolveSave, unmount } = await mountEditor("notes.md", {
      text: "Draft",
    });

    await act(async () => editor().setSource("Draft one"));
    await waitFor(() => patches.length === 1 && editor().saving);
    expect(patches[0]?.state).toEqual({ text: "Draft one" });

    await act(async () => editor().setSource("Draft one two"));
    await resolveSave();

    expect(editor().value).toBe("Draft one two");
    expect(editor().revision).toBe(2);
    expect(editor().dirty).toBe(true);
    await waitFor(() => patches.length === 2);
    expect(patches[1]).toEqual({ expected_revision: 2, state: { text: "Draft one two" } });

    await resolveSave();
    expect(editor().dirty).toBe(false);
    await unmount();
  });

  test("rich: the contentEditable body is not rewritten to the sent HTML", async () => {
    const { editor, patches, resolveSave, unmount } = await mountEditor("brief.docx", {
      document: {
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
        theme: DEFAULT_DOCUMENT_THEME,
        html: "<p>Draft</p>",
      },
    });
    const typeRich = (html: string) =>
      act(async () => {
        const surface = editor().richEditorRef.current;
        if (!surface) throw new Error("rich surface not mounted");
        surface.innerHTML = html;
        editor().onRichChange(html);
      });

    await typeRich("<p>Draft one</p>");
    await waitFor(() => patches.length === 1 && editor().saving);

    await typeRich("<p>Draft one two</p>");
    await resolveSave();

    expect(editor().richEditorRef.current?.innerHTML).toBe("<p>Draft one two</p>");
    expect(editor().dirty).toBe(true);
    await waitFor(() => patches.length === 2);
    expect(patches[1]).toMatchObject({
      expected_revision: 2,
      state: { document: { html: "<p>Draft one two</p>" } },
    });
    await resolveSave();
    expect(editor().dirty).toBe(false);
    await unmount();
  });
});
