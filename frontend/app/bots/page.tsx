import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BotsWorkspace } from "@/components/bots/bots-workspace";
import { loadBots } from "@/components/bots/load";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Bots" };

export default async function BotsPage() {
  const bots = await loadBots();
  if (bots === null) notFound();
  return <BotsWorkspace bots={bots} selected={null} thread={[]} />;
}
