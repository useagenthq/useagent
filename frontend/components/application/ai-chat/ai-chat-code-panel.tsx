"use client";

import type { ComponentType } from "react";
import { useState, type CSSProperties } from "react";
import {
  RiCornerUpLeftLine,
  RiExpandDiagonalSLine,
  RiGlobalLine,
  RiInfinityLine,
  RiSideBarLine,
  RiTerminalFill,
} from "@remixicon/react";
import { Highlight, type PrismTheme } from "prism-react-renderer";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → "ai_chat" → Changes / code panel (nodes 4030:5993,
 * 4030:6221, 4030:6061; 410px column at 1440).
 *
 * Fixed-width right panel of the AI chat template, sitting directly on the
 * page background: pill tab switcher (Changes / Browser) with terminal /
 * expand / sidebar actions, an uncommitted-changes summary card with the
 * touched file row, and the live code view — JetBrains Mono 13/23 with the
 * blue/purple keyword accents from the design.
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/* ----------------------------------------------------------------- changes */

/** React logo mark for the changed-file row (raw Figma raster, no token). */
function ReactLogo() {
  return (
    <svg aria-hidden viewBox="0 0 16 15" className="h-[14.25px] w-4 shrink-0">
      <g stroke="#149ECA" strokeWidth="0.9" fill="none">
        <ellipse cx="8" cy="7.125" rx="7.2" ry="2.85" />
        <ellipse cx="8" cy="7.125" rx="7.2" ry="2.85" transform="rotate(60 8 7.125)" />
        <ellipse cx="8" cy="7.125" rx="7.2" ry="2.85" transform="rotate(120 8 7.125)" />
      </g>
      <circle cx="8" cy="7.125" r="1.4" fill="#149ECA" />
    </svg>
  );
}

function ChangesCard() {
  return (
    <div className="flex w-full flex-col">
      {/* Summary strip — its bottom tucks behind the file row below */}
      <div className="flex w-full flex-col justify-center rounded-t-2lg border-x border-t border-background-secondary-default px-2.5 pt-1.5 pb-3.5">
        <div className="flex w-full items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="text-body-2-medium whitespace-nowrap text-text-secondary">
              12 Uncomitted changes
            </span>
            <span className="text-body-regular whitespace-nowrap text-emerald-700">+156</span>
            <span className="text-body-regular whitespace-nowrap text-red-600">-23</span>
          </div>
          <button type="button" aria-label="Undo changes" className="cursor-pointer">
            <RiCornerUpLeftLine className="size-4 text-foreground-icon-secondary" aria-hidden />
          </button>
        </div>
      </div>

      {/* Touched file row */}
      <div className="z-10 -mt-[7px] flex w-full items-center justify-between rounded-2lg bg-background-secondary-default py-1 pr-[5px] pl-1.5">
        <div className="flex min-w-0 items-center gap-1">
          <ReactLogo />
          <p className="truncate text-body-regular text-text-primary">
            boardui/app/components/button.tsx <span className="text-emerald-700">+74</span>
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center justify-center rounded-sm bg-background-tertiary-default px-1 py-px text-caption-1-medium whitespace-nowrap text-text-secondary">
          New
        </span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- code view */

const CODE = `import type { Metadata } from "next";
import Link from "next/link";
import { ComponentDetail } from "@/components/application/docs/component-detail";
import { DashboardShell } from "@/components/application/dashboard/dashboard-shell";

export const metadata: Metadata = {
  title: "Home Dashboard Template — React + Tailwind (Pro)",
  description:
    "Full admin dashboard template for React + Tailwind CSS — sidebar navigation, KPI cards, bar chart, and a customers data table. A BoardUI Pro template.",
};

const PREVIEW_CODE = \`import { DashboardShell } from "@/components/application/dashboard/dashboard-shell";

export default function DashboardPage() {
  // Full screen: floating sidebar, header, KPI cards,
  // earnings bar chart, and the customers data table.
  return <DashboardShell />;
}\`;

export default function HomeDashboardDetail() {
  return (
    <ComponentDetail
      wide
      breadcrumb={[
        { label: "Board UI", href: "/" },
        { label: "Components", href: "/components" },
        { label: "Home Dashboard" },
      ]}
      title="Home Dashboard"
      description="A complete admin dashboard screen — floating sidebar navigation, header with search and notifications, KPI stat cards, an earnings bar chart, and a customers data table."
      preview={
        <div className="h-[760px] w-full overflow-hidden rounded-2xl border border-border-button-default">
          <div className="origin-top-left scale-[0.8] [width:125%]">
            <DashboardShell />
          </div>
        </div>
      }
      previewClassName="p-3 sm:p-4"
      previewCode={PREVIEW_CODE}
      sections={[
        {
          id: "full-template",
          title: "Live template",
          body: (`;

/** Same headless-Prism palette as the docs code blocks
 *  (component-detail.tsx CODE_THEME) so the panel highlights like the rest
 *  of the site — real TSX tokenizer, BoardUI accents. */
export const AI_CHAT_CODE_THEME: PrismTheme = {
  plain: { color: "var(--color-text-secondary)" },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: { color: "var(--color-neutral-500)" } },
    { types: ["punctuation"], style: { color: "var(--color-text-tertiary)" } },
    {
      types: ["keyword", "boolean", "operator", "module", "control-flow", "important"],
      style: { color: "#7ccf00" },
    },
    {
      types: ["string", "char", "attr-value", "template-string", "regex", "url"],
      style: { color: "var(--color-neutral-500)" },
    },
    {
      types: ["class-name", "maybe-class-name", "builtin", "tag"],
      style: { color: "#00bc7d" },
    },
    { types: ["constant", "number", "symbol"], style: { color: "#2b7fff" } },
    { types: ["attr-name", "property", "parameter"], style: { color: "var(--color-text-secondary)" } },
    { types: ["function"], style: { color: "var(--color-text-secondary)" } },
  ],
};

/** Each logical line is a [number | code] row, so numbers stay aligned with
 *  their line even when long lines soft-wrap. */
function CodeView() {
  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto pl-1.5 font-mono text-[13px] leading-[23px] [scrollbar-width:thin]">
      <Highlight code={CODE} language="tsx" theme={AI_CHAT_CODE_THEME}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <code className="block">
            {tokens.map((line, i) => (
              <span key={i} {...getLineProps({ line, className: "flex min-h-[23px] items-start gap-[13px]" })}>
                <span className="w-5 shrink-0 select-none text-right text-text-tertiary">{i + 1}</span>
                <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                </span>
              </span>
            ))}
          </code>
        )}
      </Highlight>
    </div>
  );
}

/* ------------------------------------------------------------------- panel */

function PanelAction({ icon: Icon, label }: { icon: IconComponent; label: string }) {
  return (
    <button type="button" aria-label={label} className="group cursor-pointer outline-none">
      <Icon
        className="size-4 text-foreground-icon-secondary transition-colors duration-150 group-hover:text-foreground-icon-hover group-focus-visible:text-foreground-icon-hover"
        aria-hidden
      />
    </button>
  );
}

function BrowserPlaceholder() {
  return (
    <div className="flex w-full flex-1 items-center justify-center rounded-2lg bg-background-secondary-default">
      <span className="text-body-medium text-text-tertiary">Browser preview</span>
    </div>
  );
}

export function AiChatCodePanel({
  className,
  width = 410,
}: { className?: string; width?: CSSProperties["width"] } = {}) {
  const [tab, setTab] = useState<"changes" | "browser">("changes");

  return (
    <aside
      style={{ width, minWidth: width, maxWidth: width, flexBasis: width }}
      className={cx("flex h-full shrink-0 flex-col gap-2.5 overflow-hidden pt-2", className)}
    >
      {/* Tab switcher + panel actions */}
      <div className="flex h-[30px] w-full items-center justify-between">
        <PillTabList aria-label="Panel view">
          <PillTab icon={RiInfinityLine} isSelected={tab === "changes"} onSelect={() => setTab("changes")}>
            Changes
          </PillTab>
          <PillTab icon={RiGlobalLine} isSelected={tab === "browser"} onSelect={() => setTab("browser")}>
            Browser
          </PillTab>
        </PillTabList>
        <div className="flex items-center gap-2 pr-px">
          <PanelAction icon={RiTerminalFill} label="Open terminal" />
          <PanelAction icon={RiExpandDiagonalSLine} label="Expand panel" />
          <PanelAction icon={RiSideBarLine} label="Toggle panel" />
        </div>
      </div>

      {tab === "changes" ? (
        <>
          <ChangesCard />
          <div className="pt-[3px]" />
          <CodeView />
        </>
      ) : (
        <BrowserPlaceholder />
      )}
    </aside>
  );
}
