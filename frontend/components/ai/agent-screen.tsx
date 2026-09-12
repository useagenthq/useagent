"use client";

// Ported from Beautiful UI "Agent Screen" (https://www.beautifului.dev), MIT License.
// Copyright (c) 2026 Shane Levine. The upstream source is vendored verbatim at
// frontend/vendor/beautiful-ui/sources/agent-screen.tsx.txt (RSC record 26).
//
// Port notes: the placeholder capture, the decorative cursor, the faux window
// and the teach-a-task recording flow are gone. The frame shows a LIVE `screen`
// node and the viewer's action is whatever the caller passes as `controls`
// (the desktop pane passes its take-control toggle). The viewer does not
// portal a copy of the screen: the same stage element is promoted into the
// browser's top layer with the popover API, so a live iframe inside it never
// remounts (no reconnect, focus guards stay attached). Upstream tokens map to
// our semantic tokens; the screen bed is black in every theme, like a screen.

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode, Ref, RefCallback } from "react";
import { RiCollapseDiagonal2Line, RiExpandDiagonal2Line } from "@remixicon/react";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";

export type AgentScreenStatus = "loading" | "working" | "idle";

/** The sandbox desktop runs at 1440x900; the frame keeps that ratio so the
 *  scaled screen fills it edge to edge with no letterbox. */
const AGENT_SCREEN_ASPECT = "aspect-[16/10]";

const STATUS: Record<AgentScreenStatus, { label: string; color: "soft" | "blue" | "neutral" }> = {
  loading: { label: "Loading", color: "soft" },
  working: { label: "Working", color: "blue" },
  idle: { label: "Idle", color: "neutral" },
};

function AgentScreenStatusPill({ status }: { status: AgentScreenStatus }) {
  const { label, color } = STATUS[status];
  return (
    <Chip color={color} className="gap-1.5 rounded-full px-2" data-status={status}>
      {status === "working" && (
        <span aria-hidden className="ai-loading-pixel size-1.5 shrink-0 rounded-full bg-current" />
      )}
      {label}
    </Chip>
  );
}

/** Connecting state: a ring spinner on the black screen bed, the title, and an
 *  optional caption (the pane's honest probe copy). */
function AgentScreenLoading({ caption }: { caption?: string }) {
  return (
    <div
      data-testid="agent-screen-loading"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black px-6 text-center text-white"
    >
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative spinner, the text beside it carries the meaning */}
      <svg width="26" height="26" viewBox="0 0 26 26" className="animate-spin" aria-hidden>
        <circle cx="13" cy="13" r="12" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
        <circle
          cx="13"
          cy="13"
          r="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="21 55"
        />
      </svg>
      <span className="text-caption-1-medium text-white/70">{"Connecting to agent's screen"}</span>
      {caption && <span className="text-caption-1-regular text-white/50">{caption}</span>}
    </div>
  );
}

export interface AgentScreenProps {
  /** Owner of the screen: "Agent" labels the card "Agent's screen". */
  agentName?: string;
  status: AgentScreenStatus;
  /** Cover the frame with the connecting screen. */
  loading?: boolean;
  /** Second line under the connecting title (the probe's status text). */
  loadingCaption?: string;
  /** The live content that fills the frame, in the card and in the viewer. */
  screen: ReactNode;
  /** Whether the full-width viewer is showing. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Viewer title-bar controls, left of Collapse (the take-control toggle). */
  controls?: ReactNode;
  /** The stage that holds the screen and the viewer chrome in both states. */
  ref?: Ref<HTMLDivElement>;
  className?: string;
}

/**
 * A framed capture of an agent's screen. Resting, it is a view-only card
 * whose hover reveals an Open pill; open, the same stage becomes a
 * full-viewport viewer with a title bar (name, status, controls, Collapse)
 * around the screen. Escape and the scrim collapse it.
 */
export function AgentScreen({
  agentName = "Agent",
  status,
  loading = false,
  loadingCaption,
  screen,
  open,
  onOpenChange,
  controls,
  ref,
  className,
}: AgentScreenProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const setStage = useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      stageRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  // Promote the stage into the top layer while the viewer is open. A popover,
  // not a portal, keeps the screen node mounted in place, so a live iframe
  // inside it never reloads. Without the API the fixed classes below still
  // cover the viewport, just not above transformed ancestors.
  useEffect(() => {
    const stage = stageRef.current;
    if (!open || !stage || typeof stage.showPopover !== "function") return;
    if (!stage.matches(":popover-open")) stage.showPopover();
    return () => {
      if (stage.isConnected && stage.matches(":popover-open")) stage.hidePopover();
    };
  }, [open]);

  // Escape collapses the viewer. A keystroke that reaches the page, that is:
  // while the desktop has control, Escape belongs to the desktop.
  useEffect(() => {
    if (!open) return;
    const collapseOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", collapseOnEscape);
    return () => document.removeEventListener("keydown", collapseOnEscape);
  }, [open, onOpenChange]);

  const label = `${agentName}'s screen`;
  // Dialog semantics only while the stage is the viewer.
  const dialogProps = open ? { role: "dialog" as const, "aria-label": label } : {};

  return (
    <div data-agent-screen={open ? "open" : "collapsed"} className={cx("flex w-full flex-col gap-2.5", className)}>
      {/* The slot keeps the card's footprint while the stage is in the top layer. */}
      <div className={cx("relative w-full", AGENT_SCREEN_ASPECT, open && "rounded-2xl bg-background-secondary-default")}>
        <div
          ref={setStage}
          popover="manual"
          {...dialogProps}
          className={cx(
            // The stage is a manual popover in both states. Undo the UA popover
            // sheet (display:none while closed, a fixed centered box, border,
            // padding, Canvas colors) so the collapsed stage fills the slot and
            // the open stage paints its own full-viewport scrim.
            "m-0 size-auto border-0 bg-transparent p-0 text-inherit",
            open
              ? "fixed inset-0 z-50 flex items-center justify-center overflow-hidden p-4 sm:p-6"
              : "absolute inset-0 block overflow-visible",
          )}
        >
          {open && (
            <button
              type="button"
              aria-label="Collapse"
              onClick={() => onOpenChange(false)}
              className="absolute inset-0 cursor-default bg-black/60 outline-none"
            />
          )}
          <div
            className={
              open
                ? "relative flex max-h-full max-w-full flex-col overflow-hidden rounded-2xl bg-background-primary-default p-2 pt-0 shadow-dropdown"
                : "absolute inset-0"
            }
          >
            {open && (
              <div className="flex h-11 shrink-0 items-center justify-between gap-3 px-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-body-2-medium text-text-primary">{agentName}</span>
                  <AgentScreenStatusPill status={status} />
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {controls}
                  <Button
                    variant="ghost"
                    size="small"
                    iconOnly
                    leadingIcon={RiCollapseDiagonal2Line}
                    aria-label="Collapse"
                    title="Collapse"
                    onClick={() => onOpenChange(false)}
                  />
                </div>
              </div>
            )}
            <div
              data-testid="agent-screen-frame"
              className={cx(
                "relative overflow-hidden bg-black",
                open
                  ? cx("w-[min(92vw,calc((100dvh_-_7.5rem)*1.6))] rounded-xl", AGENT_SCREEN_ASPECT)
                  : "group/screen size-full rounded-2xl border border-border-button-default shadow-card transition-shadow duration-150 hover:shadow-regular-sm",
              )}
            >
              {screen}
              {loading && <AgentScreenLoading caption={loadingCaption} />}
              {!open && !loading && (
                <>
                  {/* The whole frame opens the viewer; the pill is its visual,
                      revealed on hover and on keyboard focus. Nothing to open
                      into while the screen is still connecting. */}
                  <button
                    type="button"
                    aria-label={`Open ${label}`}
                    onClick={() => onOpenChange(true)}
                    className="absolute inset-0 cursor-pointer bg-black/0 outline-none transition-colors duration-150 group-hover/screen:bg-black/20 group-focus-within/screen:bg-black/20"
                  />
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <Button
                      variant="primary"
                      size="small"
                      tabIndex={-1}
                      aria-hidden
                      leadingIcon={RiExpandDiagonal2Line}
                      className="translate-y-1 rounded-full opacity-0 transition duration-150 group-hover/screen:translate-y-0 group-hover/screen:opacity-100 group-focus-within/screen:translate-y-0 group-focus-within/screen:opacity-100"
                    >
                      Open
                    </Button>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="truncate text-body-2-medium text-text-primary">{label}</span>
        <AgentScreenStatusPill status={status} />
      </div>
    </div>
  );
}
