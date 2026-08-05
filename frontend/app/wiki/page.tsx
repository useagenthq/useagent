import type { Metadata } from "next";
import {
  RiArrowDownLine,
  RiBookOpenLine,
  RiBracesLine,
  RiGitBranchLine,
  RiLayoutMasonryLine,
  RiPaletteLine,
  RiRefreshLine,
  RiStackLine,
} from "@remixicon/react";

import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import * as Badge from "@/components/ui/badge";
import * as Button from "@/components/ui/button";
import * as Table from "@/components/ui/table";
import { AskRepoBar } from "./ask-repo-bar";
import { TableOfContents } from "./table-of-contents";

export const metadata: Metadata = {
  title: "Wiki",
  description: "Auto-generated wiki for the skynet-app codebase.",
};

/** One node in the architecture flow. */
const architecture = [
  {
    icon: RiStackLine,
    title: "app router pages",
    caption: "Server routes under app/ compose the shell + content.",
  },
  {
    icon: RiLayoutMasonryLine,
    title: "shell + feature components",
    caption: "Feature modules — shell, agent-runs, chat, code.",
  },
  {
    icon: RiBracesLine,
    title: "AlignUI base",
    caption: "Reusable primitives — Button, Table, Badge, Input…",
  },
  {
    icon: RiPaletteLine,
    title: "theme tokens",
    caption: "Semantic light/dark tokens from app/globals.css.",
  },
];

const modules = [
  {
    module: "shell",
    purpose: "App frame — TopNav, sidebars, and ⌘K search.",
    owner: "Platform",
  },
  {
    module: "agent-runs",
    purpose: "multi-repo run trace: a collapsible step timeline.",
    owner: "Agent",
  },
  {
    module: "chat",
    purpose: "New-chat hero and the model-aware composer.",
    owner: "Web",
  },
  {
    module: "base kit",
    purpose: "AlignUI primitives shared across every page.",
    owner: "Design systems",
  },
];

const conventions = [
  "Semantic theme tokens only — never raw hex, never `dark:` prefixes.",
  "Reuse an AlignUI primitive before writing a new one; one pattern per concern.",
  'Server components by default; drop to "use client" only for interactive islands.',
  "Pipeline-first: compose small pieces, one job per unit.",
  "@remixicon/react for icons, Inter for type — matching the shell.",
];

const faqs = [
  {
    q: "How is this wiki generated?",
    a: "It is synthesized from the codebase — the file tree, component boundaries, and theme tokens — and refreshed whenever the source changes.",
  },
  {
    q: "Where should I start reading?",
    a: "Skim Overview and Architecture for the shape of the app, then jump to the Key modules table for the feature-level map.",
  },
  {
    q: "Can I ask it questions?",
    a: "Yes — use the “Ask about this repo” bar below; a question hands off to a fresh agent run grounded in this wiki.",
  },
];

export default function WikiPage() {
  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="wiki" />}>
      <div className="mx-auto w-full max-w-5xl p-6 pb-24 lg:p-8 lg:pb-24">
        {/* Repo header */}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-stroke-soft-200 bg-bg-weak-50">
              <RiBookOpenLine
                className="size-5 text-text-sub-600"
                aria-hidden
              />
            </span>
            <div>
              <h1 className="text-display-md text-text-strong-950">skynet-app</h1>
              <p className="mt-0.5 text-paragraph-sm text-text-soft-400">
                Auto-generated wiki · updated 2h ago
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Badge.Root variant="lighter" size="medium" color="gray">
                  <Badge.Icon as={RiGitBranchLine} />
                  main
                </Badge.Root>
                <Badge.Root variant="lighter" size="medium" color="gray">
                  TypeScript
                </Badge.Root>
                <Badge.Root variant="lighter" size="medium" color="gray">
                  Next.js 16
                </Badge.Root>
              </div>
            </div>
          </div>

          <Button.Root variant="neutral" mode="filled" className="rounded-full">
            <Button.Icon as={RiRefreshLine} />
            Regenerate
          </Button.Root>
        </header>

        {/* Body: TOC rail + article */}
        <div className="mt-8 flex flex-col gap-8 lg:flex-row lg:gap-10">
          <TableOfContents />

          <article className="min-w-0 flex-1 space-y-12">
            {/* Overview */}
            <section id="overview" className="scroll-mt-24">
              <h2 className="text-title-h6 text-text-strong-950">Overview</h2>
              <p className="mt-3 text-paragraph-md leading-7 text-text-sub-600">
                <span className="text-text-strong-950">skynet-app</span> is the
                frontend for Skynet, a multi-repo autonomous software engineer.
                It is a Next.js 16 App Router project: every screen is composed
                from a shared shell — a top navigation bar, a contextual sidebar,
                and a scrollable main region — so the workspace, agent runs, and
                code viewer all feel like one product.
              </p>
              <p className="mt-4 text-paragraph-md leading-7 text-text-sub-600">
                The interface is built entirely from the AlignUI base kit and
                semantic theme tokens, which keeps light and dark modes in sync
                without a single raw color. Pages stay server components wherever
                possible and drop to client islands only where interactivity
                lives — the composer, the model picker, and the run trace
                timeline.
              </p>
            </section>

            {/* Architecture */}
            <section id="architecture" className="scroll-mt-24">
              <h2 className="text-title-h6 text-text-strong-950">
                Architecture
              </h2>
              <p className="mt-3 text-paragraph-md leading-7 text-text-sub-600">
                Rendering flows in one direction — routes lean on feature
                components, which lean on the base kit, which reads from the
                token layer.
              </p>
              <div className="mt-5 rounded-2xl border border-stroke-soft-200 bg-bg-weak-50 p-6">
                <div className="mx-auto flex max-w-sm flex-col items-center">
                  {architecture.map((node, index) => {
                    const Icon = node.icon;
                    return (
                      <div
                        key={node.title}
                        className="flex w-full flex-col items-center"
                      >
                        <div className="flex w-full items-start gap-3 rounded-xl border border-stroke-soft-200 bg-bg-white-0 px-4 py-3 shadow-regular-xs">
                          <Icon
                            className="mt-0.5 size-5 shrink-0 text-text-sub-600"
                            aria-hidden
                          />
                          <div className="min-w-0">
                            <p className="text-label-sm text-text-strong-950">
                              {node.title}
                            </p>
                            <p className="mt-0.5 text-paragraph-xs text-text-soft-400">
                              {node.caption}
                            </p>
                          </div>
                        </div>
                        {index < architecture.length - 1 && (
                          <RiArrowDownLine
                            className="my-2 size-5 text-text-soft-400"
                            aria-hidden
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* Data flow */}
            <section id="data-flow" className="scroll-mt-24">
              <h2 className="text-title-h6 text-text-strong-950">Data flow</h2>
              <p className="mt-3 text-paragraph-md leading-7 text-text-sub-600">
                There is no client data store — each route renders on the server,
                then hydrates the few pieces that need to react to the user.
              </p>
              <ol className="mt-4 list-decimal space-y-2 pl-5 text-paragraph-md leading-7 text-text-sub-600 marker:text-text-soft-400">
                <li>A route under app/ renders a server page.</li>
                <li>
                  It composes{" "}
                  <span className="text-text-strong-950">AppShell</span> with a
                  sidebar and the page content.
                </li>
                <li>
                  Interactive islands marked{" "}
                  <span className="text-text-strong-950">
                    &quot;use client&quot;
                  </span>{" "}
                  own their local state.
                </li>
                <li>
                  Actions navigate via next/navigation — submitting the composer
                  pushes <span className="text-text-strong-950">/agent/runs</span>
                  .
                </li>
              </ol>
            </section>

            {/* Key modules */}
            <section id="key-modules" className="scroll-mt-24">
              <h2 className="text-title-h6 text-text-strong-950">Key modules</h2>
              <p className="mt-3 text-paragraph-md leading-7 text-text-sub-600">
                The feature surface, mapped to the directories that own it.
              </p>
              <div className="mt-2">
                <Table.Root>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Module</Table.Head>
                      <Table.Head>Purpose</Table.Head>
                      <Table.Head>Owner</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {modules.map((row) => (
                      <Table.Row key={row.module}>
                        <Table.Cell>
                          <span className="font-mono text-label-sm text-text-strong-950">
                            {row.module}
                          </span>
                        </Table.Cell>
                        <Table.Cell className="text-paragraph-sm text-text-sub-600">
                          {row.purpose}
                        </Table.Cell>
                        <Table.Cell>
                          <Badge.Root
                            variant="lighter"
                            size="medium"
                            color="gray"
                          >
                            {row.owner}
                          </Badge.Root>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </div>
            </section>

            {/* Conventions */}
            <section id="conventions" className="scroll-mt-24">
              <h2 className="text-title-h6 text-text-strong-950">Conventions</h2>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-paragraph-md leading-7 text-text-sub-600 marker:text-text-soft-400">
                {conventions.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>

            {/* FAQ */}
            <section id="faq" className="scroll-mt-24">
              <h2 className="text-title-h6 text-text-strong-950">FAQ</h2>
              <dl className="mt-3 space-y-5">
                {faqs.map((faq) => (
                  <div key={faq.q}>
                    <dt className="text-label-md text-text-strong-950">
                      {faq.q}
                    </dt>
                    <dd className="mt-1 text-paragraph-md leading-7 text-text-sub-600">
                      {faq.a}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <AskRepoBar />
          </article>
        </div>
      </div>
    </AppShell>
  );
}
