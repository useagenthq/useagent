"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import {
  RiArrowRightLine,
  RiCornerDownLeftLine,
  RiGlobalLine,
  RiGroupLine,
  RiNotification2Line,
  RiTimeLine,
} from "@remixicon/react";
import { Dialog, Popover } from "react-aria-components";
import type { CalendarDate } from "@internationalized/date";
import { getLocalTimeZone } from "@internationalized/date";
import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import {
  eventDetails,
  type CalendarEvent,
} from "@/components/application/calendar/calendar-data";
import { cx } from "@/utils/cx";
import { useDismissOnOutsidePress } from "@/utils/use-dismiss-on-outside-press";

/**
 * Figma source: Board UI → "calendar_view" → "Event details modal" (node
 * 3920:10954), opened by tapping any event chip in the month grid.
 *
 * A `Popover` (`isNonModal`, no backdrop — only the panel's own shadow, same
 * overlay pattern as `CalendarInboxMenu`) anchored to the right of the day it
 * belongs to, so the event stays visible beside its own details; react-aria
 * flips it left on its own for the last column. Below `sm` there's no room to
 * sit beside anything — the panel is nearly the width of the screen — so it
 * becomes a bottom sheet instead: full-bleed, rounded across the top only,
 * rising from the bottom edge. Dismisses via outside click or Escape.
 *
 * All-day events (no `time`) render just the title/date row — Figma's
 * example is a timed event and there's no all-day variant of this design
 * to match, so meeting/time/timezone/participants/reminder are skipped
 * rather than invented.
 */

function InfoChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm bg-background-tertiary-default px-1 py-1 text-caption-1-medium text-text-secondary">
      {children}
    </span>
  );
}

/** A row inside the modal — bg-secondary rounded pill, icon + label pair on
 *  the left, optional trailing content on the right. Every non-header row
 *  in Figma shares this exact chrome. */
function DetailRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-9 w-full shrink-0 items-center gap-2.5 rounded-2lg bg-background-secondary-default py-2 pr-1.5 pl-2">
      {children}
    </div>
  );
}

export function EventDetailsModal({
  isOpen,
  event,
  date,
  triggerRef,
  onClose,
}: {
  /** Drives the popover's open/exit-animation state. Kept separate from
   *  `event`/`date` — the caller keeps those around (not nulled) while
   *  this goes false, so the panel still has content to blur/scale out
   *  instead of going blank the instant it starts closing. */
  isOpen: boolean;
  event: CalendarEvent | null;
  date: CalendarDate | null;
  /** The day cell that was clicked — the popover anchors to the right of
   *  this element. */
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const details = event ? eventDetails(event) : null;
  const popoverRef = useRef<HTMLElement>(null);

  useDismissOnOutsidePress(isOpen, onClose, [triggerRef, popoverRef]);

  const dateLabel = date
    ? new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(
        date.toDate(getLocalTimeZone()),
      )
    : "";

  const tzOffset = -new Date().getTimezoneOffset() / 60;
  const tzLabel = `GMT${tzOffset >= 0 ? "+" : ""}${tzOffset}`;

  return (
    <>
      {/* Scrim behind the sheet, light mode only — dark mode already reads as
          layered without one. react-aria gives the popover no underlay of its
          own and pins it at z-index 100000, so this portals to the body just
          beneath that. It stays mounted (transparent, inert) once opened so it
          can fade out with the sheet instead of vanishing on close — `event`
          outlives `isOpen` for exactly that reason. */}
      {event &&
        createPortal(
          <div
            aria-hidden
            className={cx(
              "fixed inset-0 z-[99999] bg-black/10 transition-opacity duration-300 ease-out sm:hidden dark:bg-transparent",
              isOpen ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          />,
          document.body,
        )}
      <Popover
        ref={popoverRef}
        triggerRef={triggerRef}
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        placement="right top"
        offset={6}
        isNonModal
        className={cx(
          "w-[302px] max-w-[calc(100vw-32px)] rounded-[20px] border border-border-button-default bg-background-primary-default p-2.5 outline-none",
          // Phones only: a bottom sheet, flush to both screen edges with 24px
          // top corners. react-aria writes the anchored placement (and a
          // computed max-height) inline, so overriding it takes !important.
          // Anywhere wider, the anchoring above is what positions it.
          "max-sm:!fixed max-sm:!inset-x-0 max-sm:!top-auto max-sm:!bottom-0 max-sm:!m-0 max-sm:!max-h-[85dvh] max-sm:w-full max-sm:max-w-none max-sm:overflow-y-auto",
          "max-sm:rounded-[24px] max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0",
          // The sheet's bottom edge meets the screen's, so its padding has to
          // clear the home indicator rather than sit under it.
          "max-sm:pb-[calc(10px+env(safe-area-inset-bottom))]",
          // Raw shadow — Figma's exact spread (0/1/2 + 0/7/8) doesn't match
          // any existing shadow token (shadow-dropdown is 0/1/1 + 0/4/4).
          // Anchored, the shadow alone separates it from the page, per Figma;
          // only the light-mode sheet gets the scrim above.
          "shadow-[0px_1px_2px_0px_rgba(0,0,0,0.04),0px_7px_8px_0px_rgba(0,0,0,0.04)]",
          "transition duration-150 ease-out",
          // Anchored to a day, it scales out of that corner; as a sheet it
          // travels the only direction a sheet can — off its own bottom edge.
          "sm:data-[entering]:scale-90 sm:data-[entering]:opacity-0 sm:data-[entering]:blur-[4px]",
          "sm:data-[exiting]:scale-90 sm:data-[exiting]:opacity-0 sm:data-[exiting]:blur-[4px]",
          "max-sm:duration-300 max-sm:data-[entering]:translate-y-full max-sm:data-[exiting]:translate-y-full",
        )}
      >
        <Dialog aria-label="Event details" className="flex w-full flex-col gap-2.5 outline-none">
          {event && details && (
            <>
              {/* Title + date */}
              <div className="flex w-full flex-col gap-px rounded-2lg bg-background-secondary-default px-2.5 py-2">
                <p className="text-headline-medium whitespace-nowrap text-text-primary">{event.title}</p>
                <p className="text-body-medium text-text-secondary">{dateLabel}</p>
              </div>

              {event.image && (
                <div className="relative h-[99px] w-full shrink-0 overflow-hidden rounded-[10px]">
                  <Image src={event.image} alt="" fill sizes="302px" className="object-cover" />
                </div>
              )}

              {event.time && (
                <>
                  {/* Google Meet */}
                  <DetailRow>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <Image src="/brand/google_meet.png" alt="" width={20} height={20} className="size-5 shrink-0" />
                      <span className="text-body-2-medium whitespace-nowrap text-text-primary">Google Meet</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <InfoChip>{details.meetingCode}</InfoChip>
                      <Button variant="primary" size="xs">
                        Join
                      </Button>
                    </div>
                  </DetailRow>

                  {/* Time range + duration */}
                  <DetailRow>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <RiTimeLine className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
                      <span className="flex items-center gap-1.5 text-body-2-medium whitespace-nowrap text-text-primary">
                        {event.time}
                        <RiArrowRightLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
                        {details.endTime}
                      </span>
                    </div>
                    <InfoChip>{durationLabel(event.time, details.endTime ?? event.time)}</InfoChip>
                  </DetailRow>

                  {/* Timezone */}
                  <DetailRow>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <RiGlobalLine className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
                      <span className="flex items-center gap-1 text-body-2-medium whitespace-nowrap">
                        <span className="text-text-secondary">{tzLabel}</span>
                        <span className="text-text-primary">Amsterdam</span>
                      </span>
                    </div>
                    <Button
                      variant="secondary"
                      size="xs"
                      iconOnly
                      leadingIcon={RiCornerDownLeftLine}
                      className="text-foreground-icon-secondary"
                      aria-label="Edit timezone"
                    />
                  </DetailRow>

                  {/* Participants */}
                  <div className="flex w-full flex-col gap-0.5 rounded-2lg bg-background-secondary-default py-2 pr-1.5 pl-2">
                    <div className="flex w-full items-center gap-2.5">
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        <RiGlobalLine className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
                        <span className="text-body-2-medium whitespace-nowrap text-text-secondary">
                          Participants
                        </span>
                      </div>
                      <Button
                        variant="secondary"
                        size="xs"
                        iconOnly
                        leadingIcon={RiGroupLine}
                        className="text-foreground-icon-secondary"
                        aria-label="Edit participants"
                      />
                    </div>
                    <div className="flex w-full flex-col">
                      {details.participants.map((participant) => (
                        <div key={participant.email} className="flex w-full items-center gap-2 rounded-2lg py-1.5">
                          <Avatar size="xs" color={participant.color} initials={participant.initials} />
                          <span className="truncate text-body-2-medium text-text-primary">{participant.email}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Reminders */}
                  <DetailRow>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <RiNotification2Line className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
                      <span className="flex items-center gap-1 text-body-2-medium whitespace-nowrap">
                        <span className="text-text-secondary">Reminders</span>
                        <span className="text-text-primary">{details.reminder}</span>
                      </span>
                    </div>
                    <Button
                      variant="secondary"
                      size="xs"
                      iconOnly
                      leadingIcon={RiCornerDownLeftLine}
                      className="text-foreground-icon-secondary"
                      aria-label="Edit reminders"
                    />
                  </DetailRow>
                </>
              )}
            </>
          )}
        </Dialog>
      </Popover>
    </>
  );
}

function durationLabel(start: string, end: string) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let minutes = eh * 60 + em - (sh * 60 + sm);
  if (minutes < 0) minutes += 24 * 60;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}
