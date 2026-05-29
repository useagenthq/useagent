"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RiCloseLine, RiCodeSLine, RiGalleryLine, RiMenuLine } from "@remixicon/react";
import { motion } from "motion/react";
import { AiChatCodePanel } from "./ai-chat-code-panel";
import { AiChatContainer, type AiChatScenario } from "./ai-chat-container";
import { AiChatGalleryPanel, type Generation } from "./ai-chat-gallery-panel";
import { AiChatSidebar } from "./ai-chat-sidebar";
import { IconButton } from "@/components/base/buttons/icon-button";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → "ai_chat" (node 4030:5897, 1440×900).
 *
 * Full AI chat template screen on the primary background with a 12px frame
 * inset: fixed 260px sidebar, the chat container flexing to fill whatever
 * width remains, and the resizable code panel on the right (16px gap to
 * the chat, 12px to the sidebar). Hovering the chat's right edge reveals a
 * drag handle (Figma node 4040:5413) — holding and dragging it trades width
 * between the chat and the code panel. Below xl the code panel hides; below
 * lg the sidebar becomes a push drawer: it slides in from the left while the
 * complete chat workspace moves right, keeping its context visible.
 */

const PANEL_DEFAULT_WIDTH = 410;
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 560;

/** The image the demo thread "generates" — mirrored into the gallery when
 *  the reveal finishes so the two panes tell one story. */
const MESSI_GENERATION: Generation = {
  id: "generated-footballer",
  prompt: "Vintage editorial Messi, Argentina kit",
  src: "/ai-chat/generated-footballer.jpg",
  tint: "from-chart-6/25 to-chart-4/25",
  ratio: "449/600",
};

/** Beat between the image finishing in the thread and it surfacing in the
 *  gallery — the two reveals reading as one motion is worse than reading as
 *  cause and effect, so the wall waits for the chat to land first. */
const GALLERY_REVEAL_DELAY_MS = 900;

/**
 * Resize grip straddling the chat container's right edge: a 15×25 white pill
 * with three grip lines, revealed on hover and while dragging. The pill
 * follows the cursor vertically along the edge; dragging calls `onResize`
 * with the horizontal delta from the drag start.
 */
function DragHandle({
  onResizeStart,
  onResize,
  isDragging,
}: {
  onResizeStart: () => void;
  onResize: (dx: number) => void;
  isDragging: boolean;
}) {
  const startX = useRef(0);
  const [gripY, setGripY] = useState<number | null>(null);

  const trackGrip = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // Keep the 25px pill fully inside the edge strip
    const y = Math.min(rect.height - 13, Math.max(13, e.clientY - rect.top));
    setGripY(y);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panels"
      onPointerDown={(e) => {
        e.preventDefault();
        startX.current = e.clientX;
        onResizeStart();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        trackGrip(e);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          onResize(e.clientX - startX.current);
        }
      }}
      className="group/drag absolute inset-y-0 -right-2.5 z-10 hidden w-5 cursor-col-resize touch-none justify-center xl:flex"
    >
      <span
        style={gripY !== null ? { top: gripY } : undefined}
        className={cx(
          "absolute flex h-[25px] w-[15px] -translate-y-1/2 items-center justify-center gap-0.5 rounded-sm border border-border-button-default bg-background-primary-default shadow-xs",
          gripY === null && "top-1/2",
          "transition-opacity duration-150 ease",
          isDragging ? "opacity-100" : "opacity-0 group-hover/drag:opacity-100",
        )}
      >
        <span className="h-[13px] w-px bg-foreground-icon-quaternary" />
        <span className="h-[13px] w-px bg-foreground-icon-quaternary" />
        <span className="h-[13px] w-px bg-foreground-icon-quaternary" />
      </span>
    </div>
  );
}

export function AiChatShell({
  className,
  contained = false,
  defaultScenario = "coding-scenario",
}: {
  className?: string;
  contained?: boolean;
  defaultScenario?: AiChatScenario;
} = {}) {
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const [isDragging, setIsDragging] = useState(false);
  const [activeScenario, setActiveScenario] = useState<AiChatScenario>(defaultScenario);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const widthAtDragStart = useRef(PANEL_DEFAULT_WIDTH);

  // Images the thread has finished generating — handed to the gallery
  // panel, which lands them at the top-left of the wall.
  const [generated, setGenerated] = useState<Generation[]>([]);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleImageGenerated = useCallback(() => {
    // A pending timer already covers this generation — don't stack another.
    if (revealTimer.current) return;
    revealTimer.current = setTimeout(() => {
      revealTimer.current = null;
      setGenerated((current) =>
        // Guard against a re-mount replaying the completion callback.
        current.some((g) => g.id === MESSI_GENERATION.id)
          ? current
          : [MESSI_GENERATION, ...current],
      );
    }, GALLERY_REVEAL_DELAY_MS);
  }, []);

  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    },
    [],
  );

  const handleResizeStart = useCallback(() => {
    widthAtDragStart.current = panelWidth;
    setIsDragging(true);
  }, [panelWidth]);

  const handleResize = useCallback((dx: number) => {
    // Dragging right widens the chat, so the panel gives up that width
    setPanelWidth(
      Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, widthAtDragStart.current - dx)),
    );
  }, []);

  const selectScenario = (id: string) => {
    if (
      id === "landing-page-design" ||
      id === "image-generation" ||
      id === "coding-scenario"
    ) {
      setActiveScenario(id);
      setMobileNavOpen(false);
    }
  };

  const panelLabel = activeScenario === "image-generation" ? "Gallery" : "Code";
  const PanelIcon = activeScenario === "image-generation" ? RiGalleryLine : RiCodeSLine;

  return (
    <div
      className={cx(
        "relative flex w-full gap-4 overflow-hidden bg-background-full p-3",
        contained ? "h-[var(--template-preview-height)]" : "h-dvh",
        isDragging && "cursor-col-resize select-none",
        className,
      )}
      onPointerUp={() => setIsDragging(false)}
      onPointerCancel={() => setIsDragging(false)}
    >
      {/* Mobile navigation stays beneath the workspace. Opening it only moves
          the workspace right while the stationary sidebar content fades in. */}
      <div
        className="absolute inset-y-0 left-0 z-10 flex w-[272px] py-3 pl-[6px] lg:hidden"
        aria-hidden={!mobileNavOpen}
      >
        <motion.div
          initial={false}
          animate={{
            scale: mobileNavOpen ? 1 : 0.94,
            opacity: mobileNavOpen ? 1 : 0,
          }}
          transition={{
            duration: 0.325,
            ease: [0.42, 0, 0.58, 1],
          }}
          className={cx(
            "h-full w-[260px] origin-left will-change-transform",
            mobileNavOpen ? "pointer-events-auto" : "pointer-events-none",
          )}
        >
          <AiChatSidebar
            activeThreadId={activeScenario}
            onThreadSelect={selectScenario}
            onClose={() => setMobileNavOpen(false)}
            flat
            className="flex"
          />
        </motion.div>
      </div>

      {/* Code and gallery stay usable on phones as a fixed-width right drawer. */}
      <div
        className={cx(
          contained ? "absolute" : "fixed",
          "inset-0 z-50 xl:hidden",
          mobilePanelOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
        aria-hidden={!mobilePanelOpen}
      >
        <button
          type="button"
          tabIndex={mobilePanelOpen ? 0 : -1}
          aria-label={`Close ${panelLabel.toLowerCase()}`}
          onClick={() => setMobilePanelOpen(false)}
          className={cx(
            "absolute inset-0 bg-black/40 transition-opacity duration-300",
            mobilePanelOpen ? "opacity-100" : "opacity-0",
          )}
        />
        <div
          className={cx(
            "absolute inset-y-0 right-0 flex w-[min(410px,calc(100%_-_12px))] flex-col bg-background-full p-3 shadow-sidebar transition-transform duration-300 ease-in-out",
            mobilePanelOpen ? "translate-x-0" : "translate-x-[110%]",
          )}
        >
          <div className="flex h-10 shrink-0 items-center justify-between px-1">
            <span className="text-headline-medium text-text-primary">{panelLabel}</span>
            <IconButton
              icon={RiCloseLine}
              size="medium"
              aria-label={`Close ${panelLabel.toLowerCase()}`}
              onClick={() => setMobilePanelOpen(false)}
            />
          </div>
          {activeScenario === "image-generation" ? (
            <AiChatGalleryPanel width="100%" generated={generated} className="min-h-0 flex-1" />
          ) : (
            <AiChatCodePanel width="100%" className="min-h-0 flex-1" />
          )}
        </div>
      </div>

      <AiChatSidebar
        activeThreadId={activeScenario}
        onThreadSelect={selectScenario}
        className={cx(
          "relative z-10 hidden lg:flex",
          // h-full, not `preview-height - 24px`: this shell frames itself with
          // its own p-3, so a percentage height already resolves against the
          // padded content box. Subtracting the frame again (as the shells
          // whose root has no padding correctly do) left the rail 24px short
          // of the workspace beside it.
          contained && "sticky top-0 h-full self-start",
        )}
      />
      <motion.div
        initial={false}
        animate={{ x: mobileNavOpen ? 272 : 0, borderRadius: mobileNavOpen ? 32 : 0 }}
        transition={{ duration: 0.325, ease: [0.42, 0, 0.58, 1] }}
        className="relative z-20 flex min-w-0 flex-1 flex-col gap-2 overflow-hidden bg-background-full will-change-transform lg:z-0 lg:!transform-none lg:!rounded-none"
      >
        <motion.button
          type="button"
          aria-label="Close navigation"
          tabIndex={mobileNavOpen ? 0 : -1}
          onClick={() => setMobileNavOpen(false)}
          initial={false}
          animate={{ opacity: mobileNavOpen ? 1 : 0 }}
          transition={{ duration: 0.325, ease: [0.42, 0, 0.58, 1] }}
          className={cx(
            "absolute inset-0 z-50 cursor-pointer rounded-[inherit] bg-black/10 dark:bg-white/5 lg:hidden",
            mobileNavOpen ? "pointer-events-auto" : "pointer-events-none",
          )}
        />
        <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-hidden">
          <div className="relative flex min-w-0 flex-1 basis-0">
            <AiChatContainer
              scenario={activeScenario}
              onImageGenerated={handleImageGenerated}
              mobileHeader={
                <header className="flex h-12 shrink-0 items-center justify-between px-3 pt-[11px] xl:hidden">
                  <div className="flex min-w-0 items-center gap-2">
                    <IconButton
                      icon={RiMenuLine}
                      size="medium"
                      aria-label="Open navigation"
                      onClick={() => {
                        setMobilePanelOpen(false);
                        setMobileNavOpen(true);
                      }}
                      className="rounded-full lg:hidden"
                    />
                    <span className="truncate px-1 text-headline-medium text-text-primary">
                      {activeScenario === "image-generation" ? "Image generation" : "Agentic chat"}
                    </span>
                  </div>
                  <IconButton
                    icon={PanelIcon}
                    size="medium"
                    aria-label={`Open ${panelLabel.toLowerCase()}`}
                    className="rounded-full"
                    onClick={() => {
                      setMobileNavOpen(false);
                      setMobilePanelOpen(true);
                    }}
                  />
                </header>
              }
            />
            <DragHandle
              onResizeStart={handleResizeStart}
              onResize={handleResize}
              isDragging={isDragging}
            />
          </div>
          {/* Image generation swaps the code panel for the gallery — same
              shell dimensions, so the drag-to-resize behaviour is unchanged. */}
          {activeScenario === "image-generation" ? (
            <AiChatGalleryPanel width={panelWidth} generated={generated} className="hidden xl:flex" />
          ) : (
            <AiChatCodePanel width={panelWidth} className="hidden xl:flex" />
          )}
        </div>
      </motion.div>
    </div>
  );
}
