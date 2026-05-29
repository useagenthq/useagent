"use client";

import {
  RiDeleteBinLine,
  RiPushpinFill,
  RiPushpinLine,
  RiStarFill,
  type RemixiconComponentType,
} from "@remixicon/react";

import * as Badge from "@/components/ui/badge";
import { cnExt } from "@/utils/cn";
import { folderChipColor, kindChipColor, type KnowledgeItem } from "./knowledge-data";

/** Small ghost icon action used in the card footer (pin / delete). */
function CardAction({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: RemixiconComponentType;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cnExt(
        "flex size-7 items-center justify-center rounded-lg transition-colors",
        "hover:bg-background-tertiary-default hover:text-text-secondary",
        active ? "text-yellow-500" : "text-text-tertiary",
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

/** Kind chip + folder chip row shared by both card densities. */
function CardMeta({ item }: { item: KnowledgeItem }) {
  return (
    <>
      {item.kind && (
        <Badge.Root variant="light" size="medium" color={kindChipColor[item.kind]}>
          {item.kind}
        </Badge.Root>
      )}
      <Badge.Root
        variant="light"
        size="medium"
        color={folderChipColor(item.folder)}
      >
        {item.folder}
      </Badge.Root>
      <span className="text-caption-1-regular text-text-tertiary">
        Updated {item.updated}
      </span>
    </>
  );
}

/** Wide highlighted card for a pinned entry — leads with a star. */
export function PinnedCard({
  item,
  onTogglePin,
  onDelete,
}: {
  item: KnowledgeItem;
  onTogglePin: (item: KnowledgeItem) => void;
  onDelete: (item: KnowledgeItem) => void;
}) {
  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-border-button-default bg-background-secondary-default p-5">
      <div className="flex items-start gap-2.5">
        <RiStarFill
          className="mt-0.5 size-5 shrink-0 text-yellow-500"
          aria-hidden
        />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-body-medium text-text-primary">{item.title}</h3>
          {item.trigger && (
            <p className="text-caption-1-regular italic text-text-tertiary">
              {item.trigger}
            </p>
          )}
        </div>
      </div>
      <p className="line-clamp-2 text-body-2-regular text-text-secondary">
        {item.body}
      </p>
      <div className="mt-auto flex items-center gap-2 pt-1">
        <CardMeta item={item} />
        <div className="ml-auto flex items-center gap-0.5">
          <CardAction
            icon={RiPushpinFill}
            label={`Unpin ${item.title}`}
            active
            onClick={() => onTogglePin(item)}
          />
          <CardAction
            icon={RiDeleteBinLine}
            label={`Delete ${item.title}`}
            onClick={() => onDelete(item)}
          />
        </div>
      </div>
    </article>
  );
}

/** Standard entry card used inside each folder group. */
export function EntryCard({
  item,
  onTogglePin,
  onDelete,
}: {
  item: KnowledgeItem;
  onTogglePin: (item: KnowledgeItem) => void;
  onDelete: (item: KnowledgeItem) => void;
}) {
  return (
    <article className="flex flex-col gap-2.5 rounded-2xl bg-background-primary-default p-4 shadow-card ring-1 ring-inset ring-border-button-default transition-colors hover:ring-border-button-hover">
      <div className="flex flex-col gap-1">
        <h3 className="text-body-medium text-text-primary">{item.title}</h3>
        {item.trigger && (
          <p className="text-caption-1-regular italic text-text-tertiary">
            {item.trigger}
          </p>
        )}
      </div>
      <p className="line-clamp-2 text-body-2-regular text-text-secondary">
        {item.body}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <CardMeta item={item} />
        <div className="ml-auto flex items-center gap-0.5">
          <CardAction
            icon={item.pinned ? RiPushpinFill : RiPushpinLine}
            label={`${item.pinned ? "Unpin" : "Pin"} ${item.title}`}
            active={item.pinned}
            onClick={() => onTogglePin(item)}
          />
          <CardAction
            icon={RiDeleteBinLine}
            label={`Delete ${item.title}`}
            onClick={() => onDelete(item)}
          />
        </div>
      </div>
    </article>
  );
}
