import type { BotAvatarIcon, BotAvatarTone } from "./types";

/**
 * Starter bots for the New bot dialog. Each one is a job people actually hand
 * to a teammate, with standing rules that make the first message useful and
 * keep the bot honest about what it must never do on its own. Picking one
 * fills the form; everything stays editable in the bot's details afterwards.
 */
export interface BotSuggestion {
  readonly name: string;
  readonly title: string;
  readonly rules: string;
  readonly icon: BotAvatarIcon;
  readonly tone: BotAvatarTone;
}

export const BOT_SUGGESTIONS: readonly BotSuggestion[] = [
  {
    name: "Night triage",
    title: "Works overnight and preps your morning digest",
    rules:
      "Every morning, summarize what happened overnight: incidents, failed jobs, open pull requests. Lead with what needs a person today. Keep it under 150 words and link every item to its source.",
    icon: "support",
    tone: "cyan",
  },
  {
    name: "Reviewer",
    title: "Reads every PR before merge and flags the risky ones",
    rules:
      "Review for correctness first, then tests, then style. Name blocking findings before nits, each with the file and line. Never approve or merge; a person does that.",
    icon: "code",
    tone: "blue",
  },
  {
    name: "Scout",
    title: "Watches competitors and writes the weekly brief",
    rules:
      "Every Monday, brief the team on what changed at each competitor: pricing, launches, hiring, docs. Cite a source for every claim and skip anything you cannot source. One page, no filler.",
    icon: "research",
    tone: "violet",
  },
  {
    name: "Support desk",
    title: "Drafts ticket replies for a person to send",
    rules:
      "Draft a reply for every ticket you are given in our voice: short, specific, one apology at most. Mark anything involving a refund, a security concern or an engineer as an escalation. Nothing sends without a person.",
    icon: "megaphone",
    tone: "amber",
  },
  {
    name: "Outbound",
    title: "Researches accounts and drafts first-touch emails",
    rules:
      "For each account, find the three facts that matter to us and draft a first email under 90 words. No invented numbers, no invented names. Flag accounts that are already customers or in an open deal. Drafts only; a person sends.",
    icon: "sales",
    tone: "rose",
  },
  {
    name: "Ledger",
    title: "Reconciles invoices and flags mismatches",
    rules:
      "Compare every invoice you are given against the ledger export. Report mismatches with the invoice number, the two amounts and the difference. Never change a figure yourself; flag it.",
    icon: "chart",
    tone: "emerald",
  },
  {
    name: "Release notes",
    title: "Turns merged PRs into notes people read",
    rules:
      "Group merged pull requests by what a user notices, not by repository. Plain sentences, no commit hashes in the text, one link per item. Say what changed for the person using it.",
    icon: "pen",
    tone: "fuchsia",
  },
  {
    name: "Chief of staff",
    title: "Keeps the weekly plan and chases what slipped",
    rules:
      "Every Friday, list what shipped, what slipped and why, and what needs a decision. Ask for each decision with a recommendation attached. Keep the whole update under 200 words.",
    icon: "compass",
    tone: "slate",
  },
];
