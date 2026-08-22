// Ported from beui.dev registry "image-generation" (components/agents/image-generation.tsx +
// lib/ease, use-hover-capable inlined). Re-expressed with our AlignUI tokens + Remixicon.
// An image-generation tile: a scanning progress overlay that resolves into a placeholder
// gradient result, with a live status line, resolution chip, and retry-on-error.
"use client";

import {
  RiCheckLine,
  RiErrorWarningLine,
  RiRestartLine,
  RiSparkling2Line,
} from "@remixicon/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

import { cx } from "@/utils/cx";

// -- motion tokens ---------------------------------------------------------
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } as const;

export type ImageGenerationStatus = "queued" | "generating" | "refining" | "complete" | "error";

export interface ImageGenerationProps {
  /** The resolved result: pass a gradient/placeholder node; it fills the tile once complete. */
  children?: ReactNode;
  status?: ImageGenerationStatus;
  label?: string;
  prompt?: string;
  resolution?: string;
  aspectRatio?: CSSProperties["aspectRatio"];
  interactive?: boolean;
  statusText?: string;
  showStatus?: boolean;
  onRetry?: () => void;
  className?: string;
  mediaClassName?: string;
  statusClassName?: string;
}

const STATUS_TEXT: Record<ImageGenerationStatus, string> = {
  queued: "Waiting to generate",
  generating: "Generating image",
  refining: "Refining details",
  complete: "Image ready",
  error: "Generation failed",
};

const MEDIA_STATE: Record<ImageGenerationStatus, { filter: string; opacity: number; scale: number }> = {
  queued: { filter: "blur(4px) saturate(0.75)", opacity: 0, scale: 1.02 },
  generating: { filter: "blur(3px) saturate(0.85)", opacity: 0, scale: 1.015 },
  refining: { filter: "blur(1.5px) saturate(0.95)", opacity: 0.62, scale: 1.005 },
  complete: { filter: "blur(0px) saturate(1)", opacity: 1, scale: 1 },
  error: { filter: "blur(2px) saturate(0.5)", opacity: 0.28, scale: 1 },
};

const OVERLAY_OPACITY: Record<ImageGenerationStatus, number> = {
  queued: 1,
  generating: 1,
  refining: 0.48,
  complete: 0,
  error: 0,
};

// -- status mark -----------------------------------------------------------
function StatusMark({ status, reduce }: { status: ImageGenerationStatus; reduce: boolean }) {
  if (status === "complete") return <RiCheckLine aria-hidden="true" className="size-3.5 text-lime-600" />;
  if (status === "error") return <RiErrorWarningLine aria-hidden="true" className="size-3.5 text-text-error-primary" />;
  return (
    <motion.span
      aria-hidden="true"
      animate={reduce ? undefined : { rotate: 360 }}
      transition={{ duration: 2.4, ease: EASE_IN_OUT, repeat: Number.POSITIVE_INFINITY }}
      className="grid size-3.5 grid-cols-2 place-items-center gap-0.5 text-accent-500"
    >
      <span className="size-1 rounded-[1px] bg-current" />
      <span className="size-1 rounded-[1px] bg-current opacity-55" />
      <span className="size-1 rounded-[1px] bg-current opacity-55" />
      <span className="size-1 rounded-[1px] bg-current" />
    </motion.span>
  );
}

// -- scanning overlay (pure CSS/motion, no canvas) -------------------------
// A soft dot grid plus a sweeping scan bar that reads as the model painting the tile.
function ScanOverlay({ reduce, status }: { reduce: boolean; status: ImageGenerationStatus }) {
  return (
    <motion.div
      aria-hidden="true"
      initial={false}
      animate={{ opacity: OVERLAY_OPACITY[status] }}
      transition={{ duration: reduce ? 0 : 0.4, ease: EASE_OUT }}
      className="absolute inset-0 overflow-hidden bg-background-secondary-default"
    >
      <div
        className="absolute inset-0 text-text-tertiary opacity-40"
        style={{
          backgroundImage: "radial-gradient(currentColor 1px, transparent 1px)",
          backgroundSize: "10px 10px",
        }}
      />
      {reduce ? null : (
        <motion.div
          initial={{ y: "-40%" }}
          animate={{ y: "140%" }}
          transition={{ duration: 1.6, ease: EASE_IN_OUT, repeat: Number.POSITIVE_INFINITY }}
          className="absolute inset-x-0 h-1/3 bg-gradient-to-b from-transparent via-background-primary-default/70 to-transparent mix-blend-overlay"
        />
      )}
    </motion.div>
  );
}

/** A single image-generation tile: scanning progress overlay that resolves into the result. */
export function ImageGenerationPanel({
  children,
  status = "generating",
  label,
  prompt,
  resolution = "1024 x 1024",
  aspectRatio = "1 / 1",
  interactive = true,
  statusText,
  showStatus = true,
  onRetry,
  className,
  mediaClassName,
  statusClassName,
}: ImageGenerationProps) {
  const reduce = useReducedMotion() ?? false;
  const active = status === "queued" || status === "generating" || status === "refining";
  const mediaState = MEDIA_STATE[status];
  const resolvedStatusText = statusText ?? STATUS_TEXT[status];
  const resolvedLabel = label ?? (prompt ? `${resolvedStatusText}: ${prompt}` : resolvedStatusText);

  return (
    <div data-slot="image-generation" data-state={status} aria-busy={active} className={cx("w-full", className)}>
      <div
        role="img"
        aria-label={resolvedLabel}
        style={{ aspectRatio }}
        className="relative isolate w-full overflow-hidden rounded-xl bg-background-secondary-default"
      >
        <motion.div
          aria-hidden={children ? undefined : true}
          initial={false}
          animate={
            reduce
              ? { opacity: mediaState.opacity }
              : { filter: mediaState.filter, opacity: mediaState.opacity, scale: mediaState.scale }
          }
          transition={reduce ? { duration: 0 } : { duration: 0.4, ease: EASE_OUT }}
          className={cx(
            "absolute inset-0 [&>*]:size-full [&>*]:object-cover [&_img]:size-full [&_img]:object-cover",
            mediaClassName,
          )}
        >
          {children}
        </motion.div>

        <AnimatePresence initial={false}>
          {active ? (
            <motion.div
              key="scan-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.25, ease: EASE_OUT }}
              className="absolute inset-0"
            >
              <ScanOverlay reduce={reduce} status={status} />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {interactive && status === "queued" ? (
          <span className="absolute inset-0 grid place-items-center text-text-tertiary">
            <RiSparkling2Line aria-hidden="true" className="size-6" />
          </span>
        ) : null}

        {resolution ? (
          <span className="absolute right-2 top-2 z-10 rounded-full bg-background-primary-default/75 px-2 py-0.5 font-mono text-[10px] tabular-nums text-text-tertiary">
            {resolution}
          </span>
        ) : null}
      </div>

      {showStatus || prompt ? (
        <div className="mt-3 text-left">
          {showStatus ? (
            <div
              aria-live="polite"
              className={cx(
                "flex min-h-5 items-center gap-2 text-body-2-medium text-text-primary",
                status === "error" && "text-text-error-primary",
                statusClassName,
              )}
            >
              <StatusMark status={status} reduce={reduce} />
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={resolvedStatusText}
                  initial={reduce ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? undefined : { opacity: 0, y: -4 }}
                  transition={{ duration: reduce ? 0 : 0.15, ease: EASE_OUT }}
                >
                  {resolvedStatusText}
                </motion.span>
              </AnimatePresence>
            </div>
          ) : null}
          {prompt ? (
            <p className="mt-0.5 truncate text-caption-1-regular text-text-secondary">&ldquo;{prompt}&rdquo;</p>
          ) : null}
        </div>
      ) : null}

      {status === "error" && onRetry ? (
        <motion.button
          type="button"
          onClick={onRetry}
          whileTap={reduce ? undefined : { scale: 0.96 }}
          transition={SPRING_PRESS}
          className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-body-2-medium text-text-primary outline-none transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <RiRestartLine aria-hidden="true" className="size-4" />
          Try again
        </motion.button>
      ) : null}
    </div>
  );
}

// -- self-driving demo -----------------------------------------------------
// A grid of tiles, each with its own placeholder gradient, cycling through the
// generation lifecycle on independent timers so the grid stays alive.
const NEXT_STATUS: Record<ImageGenerationStatus, ImageGenerationStatus> = {
  queued: "generating",
  generating: "refining",
  refining: "complete",
  complete: "queued",
  error: "queued",
};

const STATUS_DELAY: Record<ImageGenerationStatus, number> = {
  queued: 1000,
  generating: 1600,
  refining: 1200,
  complete: 2600,
  error: 2000,
};

interface DemoTile {
  id: string;
  prompt: string;
  start: ImageGenerationStatus;
  gradient: string;
}

const DEMO_TILES: DemoTile[] = [
  {
    id: "golden-hour",
    prompt: "Isometric workspace at golden hour, warm morning light",
    start: "queued",
    gradient: "radial-gradient(130% 130% at 22% 18%, #fff2e9 0%, #ffdcc4 44%, #f6bd97 78%, #eaa478 100%)",
  },
  {
    id: "dusk-city",
    prompt: "Neon city skyline reflected on wet streets at dusk",
    start: "generating",
    gradient: "radial-gradient(130% 130% at 78% 20%, #e9f0ff 0%, #c9d8ff 40%, #9aa8f6 74%, #7c72ea 100%)",
  },
  {
    id: "misty-forest",
    prompt: "Misty pine forest, soft volumetric light through the canopy",
    start: "refining",
    gradient: "radial-gradient(130% 130% at 30% 80%, #eafff4 0%, #c4f0d9 42%, #8fdcae 76%, #5fbf88 100%)",
  },
];

function TileGradient({ gradient }: { gradient: string }) {
  return (
    <div style={{ background: gradient }}>
      <div className="absolute left-4 top-4 size-10 rounded-full bg-white/45 blur-md" />
      <div className="absolute -bottom-6 -right-5 size-24 rounded-full bg-white/30 blur-2xl" />
    </div>
  );
}

function DemoTilePanel({ tile }: { tile: DemoTile }) {
  const [status, setStatus] = useState<ImageGenerationStatus>(tile.start);

  useEffect(() => {
    const t = setTimeout(() => setStatus((s) => NEXT_STATUS[s]), STATUS_DELAY[status]);
    return () => clearTimeout(t);
  }, [status]);

  return (
    <ImageGenerationPanel status={status} prompt={tile.prompt} resolution="1024 x 1024">
      <TileGradient gradient={tile.gradient} />
    </ImageGenerationPanel>
  );
}

/** Self-contained demo: a grid of tiles that generate on independent, looping timers. */
export function ImageGenerationDemo() {
  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-3 shadow-sm">
          <div className="grid grid-cols-3 gap-3">
            {DEMO_TILES.map((tile) => (
              <DemoTilePanel key={tile.id} tile={tile} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ImageGenerationDemo;
