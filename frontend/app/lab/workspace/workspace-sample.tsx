"use client";

// /lab/workspace - the session Workspace side pane rendered through the REAL
// components (WorkpieceTabStrip / WorkpieceHeader / the three editor surfaces +
// the conversation Timeline's artifact cards), fed by fixtures. Nothing here
// reimplements a renderer; it wires the live ones so the pane can be reviewed
// without a backend. The click-to-open flow is the real WorkspaceOpenProvider ->
// ArtifactRow context path used in a live session.

import type { ArtifactDescriptor } from "@useagent/agent-client";
import {
  contentTypeForName,
  DECK_THEME_PRESETS,
  DOCUMENT_THEME_PRESETS,
  inferWorkpieceKind,
  migrateSlidesToDeck,
  type DocumentTheme,
  type PresentationDeck,
  type Workbook,
} from "@useagent/artifact-workspace";
import { useEffect, useRef, useState } from "react";
import {
  DeckSurface,
  PdfBinaryCodeView,
  PdfEmbedSurface,
  RichDocumentSurface,
  SheetGridSurface,
  WorkpieceCodeView,
} from "@/app/agent/artifacts/[id]/artifact-editor-surfaces";
import { ComposerPrefillProvider } from "@/components/chat/composer-prefill-context";
import { Timeline } from "@/components/chat/conversation";
import type { TimelineNode } from "@/components/chat/timeline";
import { WorkspaceOpenProvider } from "@/components/chat/workspace-open-context";
import {
  type OpenWorkpieceTab,
  WorkpieceFollowUpComposer,
  WorkpieceHeader,
  WorkpieceTabStrip,
} from "@/components/chat/workspace-pane";

const FILES = [
  { id: "wp-doc", name: "Q2 Kickoff Brief.docx", kindLabel: "Document" },
  { id: "wp-sheet", name: "Pipeline model.xlsx", kindLabel: "Spreadsheet" },
  { id: "wp-deck", name: "Series B narrative.pptx", kindLabel: "Presentation" },
  { id: "wp-pdf", name: "Investor update.pdf", kindLabel: "PDF" },
] as const;

// A published (byte-authoritative) PDF fixture: no editable text state, so the
// pane renders an embedded preview + honest code note, never raw "%PDF" bytes.
const SAMPLE_PDF_URL = "/lab/byte-pdf-sample.pdf";
const SAMPLE_PDF_BYTES = 3_391;

const SAMPLE_DOC_HTML =
  "<h1>Q2 Kickoff Brief</h1>" +
  "<p>This document frames the <strong>Q2 objectives</strong> and the <em>key bets</em> for the team.</p>" +
  "<h2>Objectives</h2>" +
  "<ul><li>Ship the workspace side pane</li><li>Cut editor load time</li><li>Grow activation 12%</li></ul>" +
  "<h3>Owners</h3>" +
  '<p>See the <a href="https://example.com/owners">owners sheet</a> for the full list.</p>';

// A themed workbook fixture (v2): a styled header row, currency + percent number
// formats, and a Total row of =SUM / ratio formulas, plus a second sheet - so the
// grid review shows multi-sheet tabs, computed formula cells with the raw formula
// in the value bar, and number formatting.
const HEADER = { bold: true, fill: "#eef2ff", color: "#1e293b" } as const;
const SAMPLE_WORKBOOK: Workbook = {
  schemaVersion: 2,
  activeSheetId: "sheet-1",
  sheets: [
    {
      id: "sheet-1",
      name: "Pipeline",
      rowCount: 6,
      colCount: 4,
      colWidths: { A: 120, B: 140, C: 130, D: 90 },
      cells: {
        A1: { v: "Region", fmt: HEADER },
        B1: { v: "Pipeline", fmt: { ...HEADER, align: "right" } },
        C1: { v: "Closed", fmt: { ...HEADER, align: "right" } },
        D1: { v: "Win", fmt: { ...HEADER, align: "right" } },
        A2: { v: "APAC" },
        B2: { v: 1200000, fmt: { numFmt: "currency" } },
        C2: { v: 420000, fmt: { numFmt: "currency" } },
        D2: { v: 0.35, fmt: { numFmt: "percent" } },
        A3: { v: "EMEA" },
        B3: { v: 980000, fmt: { numFmt: "currency" } },
        C3: { v: 310000, fmt: { numFmt: "currency" } },
        D3: { v: 0.31, fmt: { numFmt: "percent" } },
        A4: { v: "AMER" },
        B4: { v: 1540000, fmt: { numFmt: "currency" } },
        C4: { v: 690000, fmt: { numFmt: "currency" } },
        D4: { v: 0.44, fmt: { numFmt: "percent" } },
        A5: { v: "Total", fmt: { bold: true } },
        B5: { v: 3720000, f: "=SUM(B2:B4)", fmt: { bold: true, numFmt: "currency" } },
        C5: { v: 1420000, f: "=SUM(C2:C4)", fmt: { bold: true, numFmt: "currency" } },
        D5: { v: 0.38, f: "=C5/B5", fmt: { bold: true, numFmt: "percent" } },
      },
    },
    {
      id: "sheet-2",
      name: "Notes",
      rowCount: 3,
      colCount: 2,
      cells: {
        A1: { v: "Owner", fmt: { bold: true } },
        B1: { v: "Priya" },
        A2: { v: "Updated", fmt: { bold: true } },
        B2: { v: "2026-08-18" },
      },
    },
  ],
};

// A themed deck fixture (v2): the sky preset plus an accent shape on the opener,
// so the pane review shows the deck canvas, filmstrip, theme, and blocks.
const SAMPLE_DECK: PresentationDeck = (() => {
  const base = migrateSlidesToDeck(
    [
      { title: "Series B narrative", body: "Why now\nMarket inflection\nOur wedge", notes: "Open confident" },
      { title: "Traction", body: "3.2x YoY revenue\nNRR 128%\n40 logos", notes: "Lead with NRR" },
      { title: "The ask", body: "$25M to scale GTM\n18-month runway" },
    ],
    DECK_THEME_PRESETS.find((preset) => preset.id === "sky")!.theme,
  );
  return {
    ...base,
    slides: base.slides.map((slide, index) =>
      index === 0
        ? {
          ...slide,
          blocks: [
            ...slide.blocks,
            { id: "s1-accent", type: "shape", x: 6, y: 84, w: 24, h: 4, content: "", style: { fill: "#ffd166", radius: 6 } },
          ],
        }
        : slide
    ),
  };
})();

function artifactNode(id: string, name: string): TimelineNode {
  return {
    kind: "artifact",
    key: id,
    artifact: { id, name, bytes: 24_000, sha256: "0".repeat(64), contentType: contentTypeForName(name) },
  };
}

const TIMELINE_NODES: TimelineNode[] = [
  { kind: "text", key: "intro", text: "Here are the workpieces I drafted for the kickoff:" },
  ...FILES.map((file) => artifactNode(file.id, file.name)),
];

export function WorkspaceSample() {
  const [open, setOpen] = useState<OpenWorkpieceTab[]>([
    { id: "wp-doc", name: "Q2 Kickoff Brief.docx" },
  ]);
  const [activeId, setActiveId] = useState<string | null>("wp-doc");
  const [viewMode, setViewMode] = useState<"rendered" | "code">("rendered");

  const docRef = useRef<HTMLDivElement>(null);
  const [docHtml, setDocHtml] = useState(SAMPLE_DOC_HTML);
  // A themed document fixture: the "Paper" preset (warm page + dark ink) shows the
  // deck-style theme applied to a rich document.
  const [docTheme, setDocTheme] = useState<DocumentTheme>(
    DOCUMENT_THEME_PRESETS.find((preset) => preset.id === "paper")!.theme,
  );
  const [workbook, setWorkbook] = useState<Workbook>(SAMPLE_WORKBOOK);
  const [deck, setDeck] = useState<PresentationDeck>(SAMPLE_DECK);

  // Seed the contenteditable once, the way the real editor's load() does.
  useEffect(() => {
    if (docRef.current) docRef.current.innerHTML = SAMPLE_DOC_HTML;
  }, []);

  const openWorkpiece = (artifact: { id: string; name: string }) => {
    setOpen((prev) =>
      prev.some((w) => w.id === artifact.id) ? prev : [...prev, { id: artifact.id, name: artifact.name }],
    );
    setActiveId(artifact.id);
  };
  const closeWorkpiece = (id: string) => {
    setOpen((prev) => prev.filter((w) => w.id !== id));
    if (activeId === id) {
      const remaining = open.filter((w) => w.id !== id);
      setActiveId(remaining[remaining.length - 1]?.id ?? null);
    }
  };

  const kindLabel = (id: string) => FILES.find((f) => f.id === id)?.kindLabel ?? "Document";
  const sourceFor = (id: string) => {
    if (id === "wp-doc") return docHtml;
    if (id === "wp-sheet") return JSON.stringify(workbook, null, 2);
    return JSON.stringify(deck, null, 2);
  };
  const dirtyFor = (id: string) => (id === "wp-doc" ? docHtml !== SAMPLE_DOC_HTML : false);

  // The "Ask a follow-up" composer feeds the session reply lane through the prefill
  // context; the lab captures the seeded message to show the workpieceRef prefix.
  const [followUp, setFollowUp] = useState<string | null>(null);
  const labArtifact = (tab: OpenWorkpieceTab): ArtifactDescriptor => ({
    id: tab.id,
    run_id: "run-lab",
    thread_id: "thread-lab",
    name: tab.name,
    source_path: `/work/${tab.name}`,
    content_type: contentTypeForName(tab.name),
    size_bytes: 4096,
    sha256: "0".repeat(64),
    created_at: "2026-08-18T00:00:00.000Z",
    preview_url: `/api/artifacts/${tab.id}/content`,
    download_url: `/api/artifacts/${tab.id}/content?download=1`,
    preview_pdf_url: null,
    workpiece: null,
  });
  const labKind = (name: string) => inferWorkpieceKind(name, contentTypeForName(name)) ?? "document";

  return (
    <ComposerPrefillProvider value={setFollowUp}>
    <WorkspaceOpenProvider value={openWorkpiece}>
      <main data-testid="workspace-sample" className="min-h-full bg-background-primary-default p-6">
        <div className="mx-auto max-w-6xl">
          <h1 className="text-title-2-medium text-text-primary">Workspace side pane</h1>
          <p className="mt-1 max-w-3xl text-body-2-regular text-text-secondary">
            Real session components: click a workpiece card in the conversation to open it in the
            side pane. Tabs, the rendered/Code toggle, the quiet Saved indicator, and the three
            structured editors are the exact live renderers, fed by fixtures.
          </p>

          <div className="mt-6 flex min-h-[640px] gap-4">
            {/* Conversation column with the real artifact cards. */}
            <section className="flex min-w-0 flex-1 flex-col rounded-2xl border border-border-button-default bg-background-primary-default p-4">
              <p className="text-mono-label text-text-tertiary">Conversation</p>
              <div className="mt-3">
                <Timeline nodes={TIMELINE_NODES} live={false} />
              </div>
            </section>

            {/* The right rail panel hosting the Workspace surface. */}
            <section className="flex w-[460px] shrink-0 flex-col overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default">
              <div className="flex items-center gap-2 border-b border-border-button-default px-3 py-2">
                <span className="text-mono-label text-text-tertiary">Rail</span>
                <span className="inline-flex h-6 items-center rounded-md bg-foreground-icon-primary px-2 text-caption-1-medium text-background-full">
                  Workspace
                </span>
              </div>
              <div className="relative min-h-0 flex-1">
                <div className="absolute inset-0 flex flex-col">
                  <WorkpieceTabStrip
                    tabs={open}
                    activeId={activeId}
                    onSelect={setActiveId}
                    onClose={closeWorkpiece}
                  />
                  <div className="relative min-h-0 flex-1">
                    {open.map((tab) => (
                      <div
                        key={tab.id}
                        hidden={tab.id !== activeId}
                        className="absolute inset-0 flex flex-col"
                      >
                        <WorkpieceHeader
                          name={tab.name}
                          kindLabel={kindLabel(tab.id)}
                          revision={3}
                          viewMode={viewMode}
                          onViewMode={setViewMode}
                          saving={false}
                          dirty={dirtyFor(tab.id)}
                          editable
                          onSave={() => setDocHtml(SAMPLE_DOC_HTML)}
                          downloadUrl="#"
                          exportUrl="#"
                        />
                        <WorkpieceFollowUpComposer
                          artifact={labArtifact(tab)}
                          kind={labKind(tab.name)}
                          revision={3}
                        />
                        {followUp && (
                          <div className="shrink-0 border-b border-status-purple-text/30 bg-status-purple-background/40 px-3 py-1.5 text-caption-1-regular text-text-secondary">
                            Seeded the reply composer:{" "}
                            <span className="text-text-primary">{followUp.replace(/\n/g, " ")}</span>
                          </div>
                        )}
                        <div className="flex min-h-0 flex-1 flex-col overflow-auto px-3 pb-3">
                          {tab.id === "wp-pdf" ? (
                            viewMode === "code" ? (
                              <PdfBinaryCodeView sizeBytes={SAMPLE_PDF_BYTES} />
                            ) : (
                              <PdfEmbedSurface url={SAMPLE_PDF_URL} />
                            )
                          ) : viewMode === "code" ? (
                            <WorkpieceCodeView label={kindLabel(tab.id)} source={sourceFor(tab.id)} />
                          ) : tab.id === "wp-doc" ? (
                            <RichDocumentSurface
                              editorRef={docRef}
                              loading={false}
                              onChange={setDocHtml}
                              theme={docTheme}
                              onThemeChange={setDocTheme}
                            />
                          ) : tab.id === "wp-sheet" ? (
                            <SheetGridSurface workbook={workbook} loading={false} onChange={setWorkbook} />
                          ) : (
                            <DeckSurface deck={deck} loading={false} onChange={setDeck} />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </WorkspaceOpenProvider>
    </ComposerPrefillProvider>
  );
}
