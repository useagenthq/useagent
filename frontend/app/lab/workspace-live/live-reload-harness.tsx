"use client";

// /lab/workspace-live - proves the session Workspace pane LIVE-reloads a workpiece
// when the agent revises it mid-run, for EVERY kind (slides + sheet shown here),
// through the REAL WorkspacePane + useWorkpieceEditor + org-change stream. Only the
// transport is mocked at the browser boundary - window.fetch (the client leg of
// backendFetch) and window.EventSource (the org-change SSE) - exactly how
// org-changes.test.ts fakes the stream. Nothing here reimplements a renderer.

import { contentTypeForName } from "@skynet/artifact-workspace";
import { useState } from "react";
import { WorkspacePane } from "@/components/chat/workspace-pane";

const HEX = "a".repeat(64);

type MockWorkpiece = {
  readonly id: string;
  readonly name: string;
  readonly kind: "presentation" | "spreadsheet";
  revision: number;
  state: Record<string, unknown>;
};

// Live, mutable backing state the mock fetch reads on every request. A "revision"
// button mutates this and bumps the revision, then emits an artifact change.
const STORE: Record<string, MockWorkpiece> = {
  deck: {
    id: "deck",
    name: "Series B narrative.pptx",
    kind: "presentation",
    revision: 1,
    state: {
      slides: [
        { title: "Series B narrative", body: "Why now\nMarket inflection", notes: "" },
        { title: "Traction", body: "3.2x YoY revenue\nNRR 128%", notes: "" },
      ],
    },
  },
  sheet: {
    id: "sheet",
    name: "Pipeline model.xlsx",
    kind: "spreadsheet",
    revision: 1,
    state: { csv: "Region,Pipeline,Closed\nAPAC,1200000,420000\nEMEA,980000,310000" },
  },
};

function descriptor(wp: MockWorkpiece): unknown {
  return {
    id: wp.id,
    run_id: "run-1",
    thread_id: "thread-1",
    name: wp.name,
    source_path: wp.name,
    content_type: contentTypeForName(wp.name),
    size_bytes: 4096,
    sha256: HEX,
    created_at: "2026-08-18T00:00:00.000Z",
    preview_url: `/api/artifacts/${wp.id}/preview`,
    download_url: `/api/artifacts/${wp.id}/download`,
    preview_pdf_url: null,
    workpiece: {
      kind: wp.kind,
      source_version: HEX,
      state_revision: wp.revision,
      state_url: `/api/artifacts/${wp.id}/state`,
      actions: ["preview", "download", "edit"],
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Install the transport mocks at module scope (client only), BEFORE any pane
// mounts / the org-change stream connects on first subscribe.
class LabEventSource extends EventTarget {
  static current: LabEventSource | null = null;
  readonly url: string;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
    LabEventSource.current = this;
  }
  close(): void {}
}

function emitArtifactChange(artifactId: string): void {
  LabEventSource.current?.dispatchEvent(
    new MessageEvent("change", {
      data: JSON.stringify({
        type: "artifact",
        action: "updated",
        artifactId,
        runId: "run-1",
        threadId: "thread-1",
      }),
    }),
  );
}

if (typeof window !== "undefined" && !("__labWorkspaceLive" in window)) {
  (window as unknown as Record<string, unknown>).__labWorkspaceLive = true;
  const originalFetch = window.fetch.bind(window);
  (window as unknown as { EventSource: typeof EventSource }).EventSource =
    LabEventSource as unknown as typeof EventSource;
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const wp of Object.values(STORE)) {
      if (url.endsWith(`/api/artifacts/${wp.id}`)) return json({ artifact: descriptor(wp) });
      if (url.includes(`/api/artifacts/${wp.id}/state`)) {
        const workpiece = (descriptor(wp) as { workpiece: unknown }).workpiece;
        return json({ workpiece, state: wp.state });
      }
    }
    return originalFetch(input as RequestInfo, init);
  };
  mockFetch.preconnect = originalFetch.preconnect ?? (() => {});
  window.fetch = mockFetch as typeof window.fetch;
}

function reviseDeck(): void {
  const wp = STORE.deck;
  const slides = wp.state.slides as { title: string; body: string; notes?: string }[];
  wp.state = {
    slides: [...slides, { title: "The ask", body: "$25M to scale GTM\n18-month runway", notes: "" }],
  };
  wp.revision += 1;
  emitArtifactChange("deck");
}

function reviseSheet(): void {
  const wp = STORE.sheet;
  wp.state = {
    csv: "Region,Pipeline,Closed\nAPAC,1500000,540000\nEMEA,980000,310000\nTotal,2480000,850000",
  };
  wp.revision += 1;
  emitArtifactChange("sheet");
}

function LivePane({
  id,
  name,
  onRevise,
  label,
}: {
  readonly id: string;
  readonly name: string;
  readonly onRevise: () => void;
  readonly label: string;
}) {
  return (
    <section className="flex w-[460px] shrink-0 flex-col overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default">
      <div className="flex items-center justify-between gap-2 border-b border-border-button-default px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-mono-label text-text-tertiary">Rail</span>
          <span className="inline-flex h-6 items-center rounded-md bg-foreground-icon-primary px-2 text-label-xs text-background-full">
            Workspace
          </span>
        </div>
        <button
          type="button"
          data-testid={`revise-${id}`}
          onClick={onRevise}
          className="inline-flex h-7 items-center rounded-lg border border-border-button-default px-2.5 text-label-xs text-text-secondary hover:bg-background-secondary-default hover:text-text-primary"
        >
          Simulate agent revision ({label})
        </button>
      </div>
      <div className="relative min-h-[560px] flex-1">
        <WorkspacePane
          tabs={[{ id, name }]}
          activeId={id}
          onSelect={() => {}}
          onClose={() => {}}
        />
      </div>
    </section>
  );
}

export function WorkspaceLiveHarness() {
  // Force a fresh mount when needed; not required for the proof but handy.
  const [key] = useState(0);
  return (
    <main data-testid="workspace-live" className="min-h-full bg-background-primary-default p-6">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-title-h5 text-text-primary">Workspace live-reload</h1>
        <p className="mt-1 max-w-3xl text-body-2-regular text-text-secondary">
          The real Workspace pane + editor hook + org-change stream. "Simulate agent revision"
          mutates the backing state and emits an artifact change; a clean (not-dirty) editor
          reloads and the rendered surface updates in place. Slides and sheet shown.
        </p>
        <div key={key} className="mt-6 flex flex-wrap gap-4">
          <LivePane id="deck" name="Series B narrative.pptx" onRevise={reviseDeck} label="slides" />
          <LivePane id="sheet" name="Pipeline model.xlsx" onRevise={reviseSheet} label="sheet" />
        </div>
      </div>
    </main>
  );
}
