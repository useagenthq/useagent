import type { Metadata } from "next";
import { fetchBrowse, fetchCaptures, fetchRecalls } from "./memory-api";
import type { BrowseResponse, CaptureRow, RecallLedgerRow } from "./memory-data";
import { MemoryHub } from "./memory-hub";

export const metadata: Metadata = {
  title: "Memory - UseAgent",
  description: "The team memory UseAgent recalls, captures, and can correct.",
  openGraph: {
    title: "Memory - UseAgent",
    description: "The team memory UseAgent recalls, captures, and can correct.",
    images: [{ url: "/og/12-memory.png", width: 1600, height: 900, alt: "UseAgent Memory" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Memory - UseAgent",
    description: "The team memory UseAgent recalls, captures, and can correct.",
    images: ["/og/12-memory.png"],
  },
};

export default async function MemoryPage() {
  // SSR the organization browse + activity when the backend is up. A failed
  // fetch becomes `initialError` (a distinct, retryable state) - never swallowed
  // into an empty list, so an outage never reads as "no memory yet".
  let initialBrowse: BrowseResponse | null = null;
  let initialCaptures: CaptureRow[] = [];
  let initialRecalls: RecallLedgerRow[] = [];
  let initialError = false;
  try {
    [initialBrowse, initialCaptures, initialRecalls] = await Promise.all([
      fetchBrowse("org"),
      fetchCaptures().catch(() => []),
      fetchRecalls().catch(() => []),
    ]);
  } catch {
    initialError = true;
  }

  return (
    <MemoryHub
        initialBrowse={initialBrowse}
        initialCaptures={initialCaptures}
        initialRecalls={initialRecalls}
        initialError={initialError}
      />
  );
}
