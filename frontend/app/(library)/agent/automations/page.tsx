import type { Metadata } from "next";
import { AutomationsView } from "@/app/agent/schedules/automations-view";

export const metadata: Metadata = {
  title: "Automations - UseAgent",
  description: "Recurring and triggered runs UseAgent starts on its own.",
  openGraph: {
    title: "Automations - UseAgent",
    description: "Recurring and triggered runs UseAgent starts on its own.",
    images: [{ url: "/og/06-automations.png", width: 1600, height: 900, alt: "UseAgent Automations" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Automations - UseAgent",
    description: "Recurring and triggered runs UseAgent starts on its own.",
    images: ["/og/06-automations.png"],
  },
};

export default function AutomationsPage() {
  return (
    <AutomationsView />
  );
}
