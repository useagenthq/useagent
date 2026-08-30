import type { ComponentType, ReactNode } from "react";
import { RiArrowRightUpLine, RiFileList2Line } from "@remixicon/react";
import { Chip } from "@/components/base/badges/chip";
import { cx } from "@/utils/cx";

/**
 * Retrieved-context primitive — the "All chunks · 32" pattern from the AI
 * component library, ported onto our semantic tokens. The optional source-file
 * chip (colored type badge + file name + arrow) follows the same upstream demo.
 *
 * `ContextCard` is one retrieved chunk: a title bar (glyph + name + a
 * right-aligned caption for char-count / citation) over a two-line body
 * preview, with an optional source-file chip beneath. `ContextCardStack`
 * stacks several under a labelled header with a count pill.
 *
 * Presentational only (no hooks) — safe to compose inside any client surface.
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export type SourceBadgeTone = "red" | "green" | "blue" | "purple" | "orange" | "neutral";

const badgeTone: Record<SourceBadgeTone, string> = {
  red: "bg-red-500",
  green: "bg-green-500",
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  neutral: "bg-foreground-icon-tertiary",
};

export interface ContextCardSource {
  /** File name shown in the chip, e.g. "deploy-runbook.pdf". */
  name: string;
  /** Short type badge, e.g. "PDF" or "CSV". */
  badge: string;
  tone?: SourceBadgeTone;
  href?: string;
}

export interface ContextCardProps {
  title: string;
  body: ReactNode;
  /** Right-aligned title-bar caption — char count, citation, source line… */
  meta?: string;
  /** Leading glyph; defaults to a document-lines mark. */
  icon?: IconComponent;
  /** Source-file chip under the body: colored type badge + name + arrow. */
  source?: ContextCardSource;
  className?: string;
}

function SourceChip({ source }: { source: ContextCardSource }) {
  const chipClass =
    "inline-flex h-6 items-center gap-1.5 rounded-full bg-background-secondary-default px-2 text-caption-1-medium text-text-secondary transition-colors hover:bg-background-primary-hover hover:text-text-primary";
  const content = (
    <>
      <span
        className={cx(
          "flex size-3.5 items-center justify-center rounded-[4px] text-[7px] font-bold text-white",
          badgeTone[source.tone ?? "neutral"],
        )}
        aria-hidden
      >
        {source.badge}
      </span>
      {source.name}
      <RiArrowRightUpLine className="size-2.5 shrink-0" aria-hidden />
    </>
  );
  return source.href ? (
    <a href={source.href} target="_blank" rel="noreferrer" className={chipClass}>
      {content}
    </a>
  ) : (
    <span className={chipClass}>{content}</span>
  );
}

export function ContextCard({
  title,
  body,
  meta,
  icon: Icon = RiFileList2Line,
  source,
  className,
}: ContextCardProps) {
  return (
    <article
      className={cx(
        "overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-card transition-colors hover:border-border-button-hover",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border-button-default px-3 py-2">
        <Icon
          className="size-3.5 shrink-0 text-text-tertiary"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-primary">
          {title}
        </span>
        {meta && (
          <span className="shrink-0 text-caption-1-regular tabular-nums text-text-tertiary">
            {meta}
          </span>
        )}
      </div>
      <div
        className={cx(
          "line-clamp-2 px-3 text-body-2-regular leading-relaxed text-text-secondary",
          source ? "pt-2 pb-1" : "py-2",
        )}
      >
        {body}
      </div>
      {source && (
        <div className="px-3 pb-3">
          <SourceChip source={source} />
        </div>
      )}
    </article>
  );
}

export interface ContextCardStackProps {
  label: string;
  count: number;
  cards: ContextCardProps[];
  className?: string;
}

export function ContextCardStack({
  label,
  count,
  cards,
  className,
}: ContextCardStackProps) {
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-body-2-semibold text-text-primary">{label}</span>
        <Chip color="gray">
          {count}
        </Chip>
      </div>
      {cards.map((card, i) => (
        <ContextCard key={`${card.title}-${i}`} {...card} />
      ))}
    </div>
  );
}
