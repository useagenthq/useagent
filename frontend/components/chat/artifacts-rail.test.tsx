// Two halves. First, static-markup tests of ArtifactsRailView, the presentational
// half that takes the rail's state as props: the loading, empty, unavailable and
// list states each render their own copy, and the refresh icon spins only when the
// `refreshing` prop is set. Second, an interaction test that mounts the real
// ArtifactsRail container and proves the spinner rule end to end: the initial load
// and the 5-second poll share one non-manual code path that never spins the icon,
// while a viewer's click does.
//
// The container test drives the rail through local `fetch`/`EventSource` stubs
// restored in a finally, rather than bun's mock.module: mock.module is
// process-wide and would leak a never-resolving backendFetch into every test
// file loaded after this one, hanging unrelated component tests.
import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArtifactDescriptor } from "@/components/artifacts/model";
import { ArtifactsRail, ArtifactsRailView } from "./artifacts-rail";

if (typeof window === "undefined") GlobalRegistrator.register();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const FILE: ArtifactDescriptor = {
  id: "a1",
  run_id: "r1",
  thread_id: "t1",
  name: "report.docx",
  source_path: "/root/work/report.docx",
  content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size_bytes: 2048,
  sha256: "abc123",
  created_at: "2026-01-01T00:00:00Z",
  preview_url: "https://example.com/preview",
  download_url: "https://example.com/download",
  preview_pdf_url: null,
  workpiece: null,
};

const noop = () => {};

test("the loading state shows while the backend has not answered yet", () => {
  const html = renderToStaticMarkup(
    <ArtifactsRailView artifacts={[]} available={null} refreshing={false} onRefresh={noop} />,
  );
  expect(html).toContain("Loading files...");
  expect(html).not.toContain("No files yet");
  expect(html).not.toContain("Files unavailable");
});

test("the empty state shows once the backend answers with no files", () => {
  const html = renderToStaticMarkup(
    <ArtifactsRailView artifacts={[]} available={true} refreshing={false} onRefresh={noop} />,
  );
  expect(html).toContain("No files yet");
  expect(html).not.toContain("Loading files...");
});

test("the unavailable state shows when the backend request failed", () => {
  const html = renderToStaticMarkup(
    <ArtifactsRailView artifacts={[]} available={false} refreshing={false} onRefresh={noop} />,
  );
  expect(html).toContain("Files unavailable");
  expect(html).toContain("Refresh to reconnect.");
});

test("the list state renders a card per file and no placeholder", () => {
  const html = renderToStaticMarkup(
    <ArtifactsRailView artifacts={[FILE]} available={true} refreshing={false} onRefresh={noop} />,
  );
  expect(html).toContain("report.docx");
  expect(html).not.toContain("No files yet");
  expect(html).not.toContain("Files unavailable");
});

test("the refresh icon spins and the button disables only when refreshing is set", () => {
  const spinning = renderToStaticMarkup(
    <ArtifactsRailView artifacts={[]} available={true} refreshing={true} onRefresh={noop} />,
  );
  expect(spinning).toContain("animate-spin");
  expect(spinning).toContain("disabled");

  const still = renderToStaticMarkup(
    <ArtifactsRailView artifacts={[]} available={true} refreshing={false} onRefresh={noop} />,
  );
  expect(still).not.toContain("animate-spin");
});

test("a background load never spins the icon; a manual click does", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
  // happy-dom has no EventSource; the rail's org-change subscription opens one.
  (globalThis as { EventSource?: unknown }).EventSource = class {
    close() {}
    addEventListener() {}
    removeEventListener() {}
  };
  // Hand out responses on demand so we can inspect the in-flight state.
  const resolvers: Array<(body: unknown) => void> = [];
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      resolvers.push((body) =>
        resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => body,
        } as unknown as Response),
      );
    })) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    // Mount: the initial load fires on the same non-manual path the 5-second
    // poll uses. Its request is in flight and must not spin the control.
    await act(async () => {
      root.render(<ArtifactsRail threadId="t1" live={true} />);
    });
    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh session files"]',
    );
    if (!button) throw new Error("refresh button not found");
    expect(resolvers.length).toBe(1); // the initial (non-manual) load is pending
    expect(button.querySelector(".animate-spin")).toBeNull();
    expect(button.disabled).toBe(false);

    // Finish the initial load with an empty list.
    await act(async () => {
      resolvers.shift()?.({ artifacts: [] });
    });
    expect(button.querySelector(".animate-spin")).toBeNull();

    // A viewer's click starts a manual load: now the icon spins and the button
    // locks until the request settles.
    await act(async () => {
      button.click();
    });
    expect(resolvers.length).toBe(1);
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    expect(button.disabled).toBe(true);

    await act(async () => {
      resolvers.shift()?.({ artifacts: [] });
    });
    expect(button.querySelector(".animate-spin")).toBeNull();
    expect(button.disabled).toBe(false);
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = originalFetch;
    (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  }
});
