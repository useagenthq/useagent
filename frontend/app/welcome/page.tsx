import { RiCheckLine } from "@remixicon/react";
import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { ChatSidebar } from "@/components/shell/chat-sidebar";
import { ConnectAppsModal } from "./connect-apps-modal";
import { CopyPill } from "./copy-pill";
import { Mascot } from "./mascot";
import { TerminalCard } from "./terminal-card";

export const metadata: Metadata = {
  title: "Welcome",
  description:
    "Build AI apps locally with Skynet — run powerful open models in minutes.",
};

const CHECKLIST = [
  "Run larger models instantly",
  "Parallelize complex workflows",
  "Connect to live web data",
];

export default function WelcomePage() {
  return (
    <AppShell activeTab="chat" sidebar={<ChatSidebar active="welcome" />}>
      <div className="w-full max-w-2xl px-8 py-10 sm:px-14 sm:py-14">
        {/* Intro */}
        <Mascot />
        <h1 className="mt-6 text-display-lg text-text-strong-950">
          Build AI apps locally
        </h1>
        <p className="mt-2 text-paragraph-sm text-text-sub-600">
          Run powerful open models in minutes.
        </p>
        <CopyPill
          className="mt-8"
          command="curl -fsSL https://skynet.run/install.sh | sh"
        />

        <hr className="my-10 border-stroke-soft-200" />

        {/* Launch your workspace */}
        <div className="grid gap-8 sm:grid-cols-2 sm:items-center">
          <TerminalCard />
          <div className="flex flex-col gap-4">
            <h2 className="text-title-h5 text-text-strong-950">
              Launch your workspace
            </h2>
            <p className="text-paragraph-sm text-text-sub-600">
              Start coding, researching, and automating with OpenClaw and
              Skynet.
            </p>
            <CopyPill command="skynet launch openclaw" />
          </div>
        </div>

        {/* Local first. Cloud ready. */}
        <div className="mt-16 flex flex-col gap-4">
          <h2 className="text-title-h5 text-text-strong-950">
            Local first. Cloud ready.
          </h2>
          <p className="text-paragraph-sm text-text-sub-600">
            Scale from your laptop to larger hosted models whenever you need more
            power.
          </p>
          <ul className="mt-2 flex flex-col gap-3">
            {CHECKLIST.map((item) => (
              <li key={item} className="flex items-center gap-3">
                <RiCheckLine
                  className="size-4 shrink-0 text-text-soft-400"
                  aria-hidden
                />
                <span className="text-paragraph-sm text-text-sub-600">
                  {item}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <ConnectAppsModal />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
