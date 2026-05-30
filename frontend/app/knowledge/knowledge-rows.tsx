"use client";

import { useState } from "react";
import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiDeleteBinLine,
  RiExternalLinkLine,
  RiPushpinFill,
  RiPushpinLine,
  RiStarFill,
} from "@remixicon/react";

import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";
import { kindChipColor, type KnowledgeItem } from "./knowledge-data";

/**
 * Compact knowledge row: title + kind chip, one caption meta line
 * (folder / source / age), and a two-line clamped body. The whole text block
 * is a disclosure trigger — expanding reveals the full body plus the quieter
 * distilled metadata (summary, question, connector, refs, entities,
 * confidence, source link) that would be noise on the collapsed row.
 * Pin / delete stay as ghost icon actions on the right.
 */
export function KnowledgeRow({
  item,
  onTogglePin,
  onDelete,
}: {
  item: KnowledgeItem;
  onTogglePin: (item: KnowledgeItem) => void;
  onDelete: (item: KnowledgeItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = `knowledge-details-${item.id}`;

  const details: Array<[string, string]> = [];
  if (item.trigger) details.push(["Recall when", item.trigger]);
  if (item.question) details.push(["Question", item.question]);
  if (item.summary) details.push(["Summary", item.summary]);
  if (item.sourceType) details.push(["Source", item.sourceType]);
  if (item.connectorId) details.push(["Connector", item.connectorId]);
  if (item.confidence !== undefined)
    details.push(["Confidence", String(item.confidence)]);
  if (item.refs?.length) details.push(["Refs", item.refs.join(", ")]);
  if (item.entities?.length) details.push(["Entities", item.entities.join(", ")]);

  return (
    <li>
      <div className="flex items-start gap-2 px-4 py-3 transition-colors hover:bg-background-secondary-default">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 flex-col gap-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <span className="flex w-full min-w-0 items-center gap-2">
            {item.pinned && (
              <RiStarFill
                aria-hidden
                className="size-4 shrink-0 text-yellow-500"
              />
            )}
            <span className="truncate text-body-medium text-text-primary">
              {item.title}
            </span>
            {item.kind && (
              <Chip
                variant="caption"
                color={kindChipColor[item.kind]}
                className="shrink-0"
              >
                {item.kind}
              </Chip>
            )}
            {open ? (
              <RiArrowUpSLine
                aria-hidden
                className="ml-auto size-4 shrink-0 text-text-tertiary"
              />
            ) : (
              <RiArrowDownSLine
                aria-hidden
                className="ml-auto size-4 shrink-0 text-text-tertiary"
              />
            )}
          </span>
          <span className="flex w-full min-w-0 items-center gap-1.5 text-caption-1-regular text-text-tertiary">
            <span className="truncate">{item.folder}</span>
            {item.sourceType && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0">{item.sourceType}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span className="shrink-0">{item.updated}</span>
          </span>
          {!open && (
            <span className="line-clamp-2 w-full text-body-2-regular text-text-secondary">
              {item.body}
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            iconOnly
            variant="ghost"
            size="xs"
            leadingIcon={item.pinned ? RiPushpinFill : RiPushpinLine}
            aria-label={`${item.pinned ? "Unpin" : "Pin"} ${item.title}`}
            aria-pressed={item.pinned}
            className={cx(item.pinned && "text-yellow-500")}
            onClick={() => onTogglePin(item)}
          />
          <Button
            iconOnly
            variant="ghost"
            size="xs"
            leadingIcon={RiDeleteBinLine}
            aria-label={`Delete ${item.title}`}
            onClick={() => onDelete(item)}
          />
        </div>
      </div>
      {open && (
        <div
          id={detailsId}
          className="flex flex-col gap-3 border-t border-separator-border bg-background-secondary-default px-4 py-3"
        >
          <p className="whitespace-pre-wrap text-body-2-regular text-text-secondary">
            {item.body}
          </p>
          {details.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {details.map(([term, value]) => (
                <div key={term} className="contents">
                  <dt className="text-caption-1-regular text-text-tertiary">
                    {term}
                  </dt>
                  <dd className="min-w-0 break-words text-caption-1-regular text-text-secondary">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {item.sourceUrl && (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1 text-caption-1-medium text-text-secondary underline-offset-2 transition-colors hover:text-text-primary hover:underline"
            >
              Open source
              <RiExternalLinkLine aria-hidden className="size-3.5" />
            </a>
          )}
        </div>
      )}
    </li>
  );
}
