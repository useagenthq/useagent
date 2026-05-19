"use client";

import { ChatComposer } from "@/components/ai/chat-composer";
import { CodeBlock } from "@/components/ai/code-block";
import { FineTuneCard } from "@/components/ai/fine-tune-card";
import { PromptBar } from "@/components/ai/prompt-bar";
import { SearchList } from "@/components/ai/search-list";
import { SelectionActions } from "@/components/ai/selection-actions";
import { SidebarNav } from "@/components/ai/sidebar-nav";

import { BEAUTIFUL_UI_COMPONENTS } from "./beautiful-ui-inventory";

function Demo({
  component,
  children,
  title,
  index,
  description,
  wide = false,
}: {
  component: string;
  children: React.ReactNode;
  title?: string;
  index?: number;
  description?: string;
  wide?: boolean;
}) {
  return (
    <section
      data-beautiful-ui-component={component}
      className={
        wide
          ? "flex flex-col gap-7 border-t border-stroke-soft-200 py-14"
          : "flex flex-col gap-6 border-t border-stroke-soft-200 py-8"
      }
    >
      {title ? (
        <div className="flex items-baseline gap-4">
          {typeof index === "number" && (
            <span className="text-paragraph-sm text-text-soft-400 tabular-nums">{index}</span>
          )}
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 className="text-title-h6 text-text-strong-950">{title}</h2>
            {description && <p className="text-paragraph-md text-text-soft-400">{description}</p>}
          </div>
        </div>
      ) : (
        <p className="text-mono-label text-text-soft-400">AI kit · {component}</p>
      )}
      <div
        className={
          wide
            ? "relative left-1/2 w-[min(1220px,calc(100vw-24rem))] min-w-0 -translate-x-1/2"
            : undefined
        }
      >
        {children}
      </div>
    </section>
  );
}

export function BeautifulUiExtras() {
  return (
    <>
      <section className="border-t border-stroke-soft-200 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-title-h6 text-text-strong-950">Beautiful UI inventory</p>
            <p className="mt-1 text-paragraph-sm text-text-sub-600">
              All 19 MIT-licensed source snapshots have a local production port and a live lab
              surface.
            </p>
          </div>
          <span className="rounded-full bg-success-lighter px-3 py-1 text-label-sm text-success-base">
            19 / 19
          </span>
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {BEAUTIFUL_UI_COMPONENTS.map((component) => (
            <span
              key={component}
              className="rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-2 py-1 text-mono-label text-text-sub-600"
            >
              {component}
            </span>
          ))}
        </div>
      </section>

      <Demo component="chat-composer">
        <ChatComposer />
      </Demo>

      <Demo component="prompt-bar">
        <PromptBar />
      </Demo>

      <Demo component="sidebar-nav">
        <SidebarNav />
      </Demo>

      <Demo component="search">
        <SearchList />
      </Demo>

      <Demo component="code-block">
        <CodeBlock
          filename="recommend-flavors.ts"
          language="ts"
          code={`export function recommendFlavors(season: string) {
  return season === 'summer'
    ? ['mango', 'mint chip', 'pistachio']
    : ['vanilla', 'chocolate'];
}`}
        />
      </Demo>

      <Demo component="fine-tune-card">
        <FineTuneCard />
      </Demo>

      <Demo
        component="selection-actions"
        title="Selection Actions"
        index={19}
        description="Highlight a passage and hand it to the agent to rewrite."
        wide
      >
        <SelectionActions className="min-h-[548px]" />
      </Demo>
    </>
  );
}
