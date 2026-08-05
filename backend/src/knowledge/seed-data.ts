/**
 * Seed corpus — transcribed from the frontend's mock
 * (frontend/app/knowledge/knowledge-data.ts) so the backend has no runtime
 * dependency on frontend source. These are ingested through the REAL ingest
 * path on first boot, so the stored corpus is genuine distilled output when an
 * OpenRouter key is present (and faithful stubs when not).
 */
export interface SeedEntry {
  id: string;
  name: string;
  trigger: string;
  body: string;
  folder: string;
  pinned?: boolean;
}

export const seedEntries: SeedEntry[] = [
  {
    id: "boardui-tokens",
    name: "BoardUI tokens are the only styling primitive",
    trigger: "When writing or reviewing any component styling",
    body: "Style exclusively with the semantic theme tokens from styles/theme.css — bg-background-primary-default, text-text-primary, border-border-button-default. Never reach for raw hex or Tailwind color literals, and skip dark: prefixes: the .dark class strategy remaps every token for you.",
    folder: "Global",
    pinned: true,
  },
  {
    id: "reuse-base-kit",
    name: "Reuse the base kit before building anything new",
    trigger: "When you need an input, button, chip, select, switch, or modal",
    body: "Every primitive already lives in components/base. Import Button, Input, Chip, Select, and Switch instead of re-implementing them — a parallel near-duplicate is a review blocker. Search the kit first, then extend it if a variant is genuinely missing.",
    folder: "Global",
    pinned: true,
  },
  {
    id: "semantic-colors",
    name: "Semantic colors only — never raw hex",
    trigger: "When choosing a color for a background, text, border, or status",
    body: "Map every color to a semantic token so light and dark both resolve. The status-* tokens (lime, yellow, blue, purple) already carry their own light+dark pairs — prefer the Chip color prop over hand-rolled color classes.",
    folder: "Global",
  },
  {
    id: "remix-icons",
    name: "Icons come from @remixicon/react only",
    trigger: "When adding an icon to any surface",
    body: "Pass the component reference (RiSearchLine), never a rendered <RiSearchLine />, and let the consuming primitive size it. No inline SVGs and no second icon pack — consistency across the shell depends on a single source.",
    folder: "Global",
  },
  {
    id: "app-shell-frame",
    name: "AppShell is the page-frame contract",
    trigger: "When scaffolding a new route under app/",
    body: "Wrap the page in <AppShell activeTab=… sidebar={…}>. It renders TopNav + the sidebar + a scrollable main on the rounded bg-background-secondary canvas. Don't rebuild the frame per page — pass a sidebar and let the shell own the chrome.",
    folder: "skynet-app",
  },
  {
    id: "rebrand-skynet",
    name: "Rebrand every legacy 'Alpaca' / 'OpenClaw' string",
    trigger: "When you see old product naming in copy, metadata, or seed data",
    body: "The inspiration deck ships as 'Alpaca Super Computer' with openclaw references; our product is Skynet. Replace every visible occurrence — headings, metadata titles, and mock data — so nothing leaks the source branding.",
    folder: "skynet-app",
  },
  {
    id: "client-boundary",
    name: "Keep 'use client' at the interactive leaf",
    trigger: "When a page needs state, effects, or event handlers",
    body: "Leave page.tsx as a server component for metadata and the shell, then push 'use client' down into the colocated interactive piece (search, modal, filters). This mirrors app/apps and app/artifacts and keeps the route payload lean.",
    folder: "skynet-app",
  },
  {
    id: "run-trace-timeline",
    name: "Run traces read as a vertical timeline",
    trigger: "When rendering an agent run or tool log",
    body: "Follow the run-trace convention: a summary header (tools / files / commands + elapsed time), then a vertical timeline of steps with command and file chips, a JSON block with a Copy affordance, and a Done check to close it out.",
    folder: "Growth Operator",
  },
  {
    id: "pipeline-fan-out",
    name: "Pipeline stages fan out — no barrier by default",
    trigger: "When wiring a multi-step agent workflow",
    body: "Prefer pipelining each item through all stages independently over synchronized barriers. Only collect every result at once when a stage genuinely needs cross-item context — dedup before expensive work, or an early-exit when the count is zero.",
    folder: "Growth Operator",
  },
  {
    id: "status-dots-recents",
    name: "Recents use colored status dots for live runs",
    trigger: "When listing sessions in the agent sidebar",
    body: "Active runs get a StatusDot (indigo for in-flight); idle entries fall back to a hollow neutral ring. Keep the tone list in sync with the run state so the sidebar reads as a live queue, not a static menu.",
    folder: "Growth Operator",
  },
];
