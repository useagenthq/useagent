import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BotsWorkspace } from "@/components/bots/bots-workspace";
import { loadBot, loadBots, loadHomeThread } from "@/components/bots/load";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const bot = await loadBot(id);
  return { title: bot ? `${bot.name} - Bots` : "Bots" };
}

export default async function BotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [bots, bot] = await Promise.all([loadBots(), loadBot(id)]);
  if (bots === null || !bot) notFound();
  const thread = bot.homeThreadId ? await loadHomeThread(bot.homeThreadId) : [];
  return <BotsWorkspace bots={bots} selected={bot} thread={thread} />;
}
