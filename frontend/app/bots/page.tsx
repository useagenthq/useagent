import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BotsWorkspace } from "@/components/bots/bots-workspace";
import { loadBots } from "@/components/bots/load";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Bots",
  openGraph: {
    title: "Bots - UseAgent",
    description: "Automate tasks with always-on AI bots that run in your workspace.",
    images: [{ url: "/og/05-agents.png", width: 1600, height: 900, alt: "UseAgent Bots" }],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og/05-agents.png"],
  },
};

export default async function BotsPage() {
  const bots = await loadBots();
  if (bots === null) notFound();
  return <BotsWorkspace bots={bots} selected={null} thread={null} />;
}
