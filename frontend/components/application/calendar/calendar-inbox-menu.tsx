"use client";

import { Fragment, useRef, useState } from "react";
import { RiAddFill, RiInbox2Line, RiRssFill } from "@remixicon/react";
import { Dialog, Popover } from "react-aria-components";
import { Button } from "@/components/base/buttons/button";
import { IconButton } from "@/components/base/buttons/icon-button";
import { cx } from "@/utils/cx";
import { useDismissOnOutsidePress } from "@/utils/use-dismiss-on-outside-press";

/**
 * Figma source: Board UI → "calendar_view" → inbox dropdown (node
 * 3905:9752). Subscribed calendar feeds grouped by account email, each row
 * a colored 20px icon swatch (`rss-fill`, bg-*-200 / icon *-700 — blue is
 * the one exception, *-900, straight from the Figma variables) + label, a
 * full-bleed divider between accounts (not after the last one), and a
 * full-width "Add new account" button. "Holidays in Hetherlands" is Figma's
 * own text as-is (not a typo I introduced).
 */

type FeedColor = "blue" | "red" | "lime" | "purple" | "teal" | "pink";

interface FeedItem {
  id: string;
  label: string;
  color: FeedColor;
}

interface FeedAccount {
  email: string;
  items: FeedItem[];
}

const SWATCH_STYLES: Record<FeedColor, string> = {
  blue: "bg-blue-200 text-blue-900",
  red: "bg-red-200 text-red-700",
  lime: "bg-lime-200 text-lime-700",
  purple: "bg-purple-200 text-purple-700",
  teal: "bg-teal-200 text-teal-700",
  pink: "bg-pink-200 text-pink-700",
};

const FEED_ACCOUNTS: FeedAccount[] = [
  {
    email: "hi@mertcan.works",
    items: [
      { id: "mertcan-incoming", label: "Incoming events", color: "blue" },
      { id: "mertcan-f1", label: "F1 Schedule", color: "red" },
      { id: "mertcan-holidays", label: "Holidays in Hetherlands", color: "lime" },
    ],
  },
  {
    email: "mertcanesmergul@gmail.com",
    items: [
      { id: "gmail-incoming", label: "Incoming events", color: "blue" },
      { id: "gmail-worldcup", label: "World Cup 2026", color: "purple" },
    ],
  },
  {
    email: "hi@strider.studio",
    items: [
      { id: "strider-incoming", label: "Incoming events", color: "blue" },
      { id: "strider-ufc", label: "UFC Nights", color: "teal" },
      { id: "strider-hotd", label: "House of Dragons", color: "pink" },
    ],
  },
];

function FeedRow({ item, onSelect }: { item: FeedItem; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full cursor-pointer items-center gap-2 rounded-2lg px-2 py-1.5 outline-none transition-colors hover:bg-background-primary-hover focus-visible:bg-background-primary-hover"
    >
      <span className={cx("flex size-5 shrink-0 items-center justify-center rounded-md", SWATCH_STYLES[item.color])}>
        <RiRssFill className="size-3" aria-hidden />
      </span>
      <span className="truncate text-body-medium text-text-primary">{item.label}</span>
    </button>
  );
}

function FeedAccountGroup({ account, onSelect }: { account: FeedAccount; onSelect: () => void }) {
  return (
    <div className="flex w-full flex-col gap-1.5 pt-[5px]">
      <p className="pl-2 text-body-medium text-text-secondary">{account.email}</p>
      <div className="flex w-full flex-col gap-1">
        {account.items.map((item) => (
          <FeedRow key={item.id} item={item} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

/**
 * The calendar template's inbox icon opens this subscribed-feeds dropdown
 * — anchored to the icon via the same external `triggerRef`/`isOpen`
 * pattern used by the other calendar header pieces.
 */
export function CalendarInboxMenu({ triggerClassName }: { triggerClassName?: string } = {}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const close = () => setIsOpen(false);

  useDismissOnOutsidePress(isOpen, close, [triggerRef, popoverRef]);

  return (
    <>
      <IconButton
        ref={triggerRef}
        icon={RiInbox2Line}
        size="medium"
        aria-label="Inbox"
        onClick={() => setIsOpen((open) => !open)}
        className={triggerClassName}
      />
      <Popover
        ref={popoverRef}
        triggerRef={triggerRef}
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        placement="bottom end"
        offset={8}
        isNonModal
        className={cx(
          "w-[266px] max-w-[calc(100vw-32px)] origin-top-right overflow-y-auto",
          "rounded-2xl border border-border-button-default bg-background-primary-default p-2.5 shadow-dropdown",
          "transition duration-150 ease-out",
          "data-[entering]:opacity-0 data-[entering]:scale-95 data-[entering]:blur-[2px]",
          "data-[exiting]:opacity-0 data-[exiting]:scale-95 data-[exiting]:blur-[2px]",
        )}
      >
        <Dialog aria-label="Inbox menu" className="flex flex-col gap-4 outline-none">
          {FEED_ACCOUNTS.map((account, index) => (
            <Fragment key={account.email}>
              {index > 0 && <div className="-mx-2.5 -my-1 h-px bg-border-button-default" />}
              <FeedAccountGroup account={account} onSelect={close} />
            </Fragment>
          ))}
          <Button variant="secondary" size="small" leadingIcon={RiAddFill} className="w-full" onClick={close}>
            Add new account
          </Button>
        </Dialog>
      </Popover>
    </>
  );
}
