import type { Metadata } from "next";
import { fetchSkills } from "@/app/(library)/skills/skills-api";
import { mockSkills } from "@/app/(library)/skills/skills-data";
import { PlaybooksView } from "./playbooks-view";

export const metadata: Metadata = {
  title: "Playbooks - UseAgent",
  description: "Structured procedures UseAgent follows as guidance for repeatable work.",
  openGraph: {
    title: "Playbooks - UseAgent",
    description: "Structured procedures UseAgent follows as guidance for repeatable work.",
    images: [{ url: "/og/13-playbooks.png", width: 1600, height: 900, alt: "UseAgent Playbooks" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Playbooks - UseAgent",
    description: "Structured procedures UseAgent follows as guidance for repeatable work.",
    images: ["/og/13-playbooks.png"],
  },
};

export default async function PlaybooksPage() {
  // SSR the real playbooks when the backend is up. A failed fetch is surfaced as
  // `initialError` (a distinct, retryable state) - NOT swallowed into the empty
  // seed, so an outage never reads as "no playbooks yet". Same substrate as
  // Skills, scoped to kind=playbook.
  let initialPlaybooks = mockSkills;
  let initialLive = false;
  let initialError = false;
  try {
    initialPlaybooks = await fetchSkills("playbook");
    initialLive = true;
  } catch {
    initialError = true;
  }

  return (
    <PlaybooksView
        initialPlaybooks={initialPlaybooks}
        initialLive={initialLive}
        initialError={initialError}
      />
  );
}
