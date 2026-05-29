"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  RiCheckLine,
  RiFileCopyLine,
  RiFolderLine,
  RiLinkM,
  RiMoreFill,
  RiShare2Line,
  RiThumbDownLine,
  RiThumbUpLine,
} from "@remixicon/react";
import { Focusable } from "react-aria-components";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { Highlight } from "prism-react-renderer";
import { AI_CHAT_CODE_THEME } from "@/components/application/ai-chat/ai-chat-code-panel";
import { GlassComposer, StatusBar } from "@/components/application/ai-chat/ai-chat-composer";
import { AgentProgressLoadingText } from "@/components/application/agent-progress/agent-progress-loading-text";
import { AgentProgress } from "@/components/application/agent-progress/agent-progress";
import { AgentThinking } from "@/components/application/agent-thinking/agent-thinking";
import { ComposerLoader } from "@/components/application/composer-loader/composer-loader";
import { Breadcrumb, BreadcrumbItem } from "@/components/base/breadcrumb/breadcrumb";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → "ai_chat" → Chat_container (node 4032:6224,
 * 718×876 at 1440).
 *
 * The center column of the AI chat template: a radius/3xl
 * background/secondary surface with a breadcrumb header (project › chat +
 * share/more actions), the scrollable message thread, the pill composer
 * (attach, input, model picker, mic, send), and the status bar (branch,
 * project, mode, context meter). Flexes to fill the space between the
 * fixed sidebar and the fixed-width code panel.
 */

/* ------------------------------------------------------------------ thread */

/** Each line of a message blurs + fades in as it "streams". */
const LINE_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 6, filter: "blur(6px)" },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] },
  },
};

/** The generated-image frame unfolds: its height grows 0 → 250px while the
 *  card blurs in, so the conversation above is pushed up smoothly instead
 *  of jumping when the fixed-height frame mounts. Fades/blur finish before
 *  the growth does — motion never outlives the fade. */
const IMAGE_FRAME_VARIANTS: Variants = {
  hidden: { height: 0, opacity: 0, filter: "blur(6px)" },
  visible: {
    height: 250,
    opacity: 1,
    filter: "blur(0px)",
    transition: {
      height: { duration: 0.55, ease: [0.22, 1, 0.36, 1] },
      opacity: { duration: 0.35, ease: "easeOut" },
      filter: { duration: 0.35, ease: "easeOut" },
    },
  },
};

/** Message container fades in softly while staggering its lines
 *  top-to-bottom. */
const MESSAGE_VARIANTS: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.4, ease: "easeOut", staggerChildren: 0.18 },
  },
};

/** A block of a message (paragraph, list, feedback row) that blurs in. */
export function Line({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={LINE_VARIANTS} className={className}>
      {children}
    </motion.div>
  );
}

/** 28px square feedback action (p 6 + 16px glyph) on background/tertiary,
 *  with the shared tooltip naming it. `Focusable` adapts the plain button
 *  for react-aria's TooltipTrigger, same pattern as the data tables.
 *
 *  Hover deepens the glyph to foreground/icon/primary — which resolves
 *  darker in light mode and brighter in dark mode, so the affordance reads
 *  the same way in both themes. */
function FeedbackButton({
  icon: Icon,
  label,
  tooltip,
  isTooltipOpen,
  onTooltipOpenChange,
  onPress,
  children,
}: {
  icon?: typeof RiThumbUpLine;
  label: string;
  /** Tooltip copy when it differs from the accessible name (e.g. "Copied!"). */
  tooltip?: string;
  /** Controls the tooltip so a confirmation can hold it open, then dismiss
   *  it even while the pointer is still over the button. */
  isTooltipOpen?: boolean;
  onTooltipOpenChange?: (open: boolean) => void;
  onPress?: () => void;
  /** Custom glyph (e.g. the copy → check crossfade). Wins over `icon`. */
  children?: ReactNode;
}) {
  return (
    <TooltipTrigger delay={200} isOpen={isTooltipOpen} onOpenChange={onTooltipOpenChange}>
      <Focusable>
        <button
          type="button"
          aria-label={label}
          onClick={onPress}
          className={cx(
            "group flex cursor-pointer items-center rounded-lg bg-background-tertiary-default p-1.5",
            "transition-colors duration-150 ease hover:bg-background-secondary-hover",
          )}
        >
          {children ??
            (Icon ? (
              <Icon
                className={cx(
                  "size-4 text-foreground-icon-secondary transition-colors duration-150 ease",
                  "group-hover:text-foreground-icon-primary",
                )}
                aria-hidden
              />
            ) : null)}
        </button>
      </Focusable>
      <Tooltip size="sm">{tooltip ?? label}</Tooltip>
    </TooltipTrigger>
  );
}

/** Copy → check crossfade, same recipe as the docs code blocks: each glyph
 *  blurs + scales + fades as the state flips. */
function FeedbackCopyGlyph({ copied }: { copied: boolean }) {
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <RiFileCopyLine
        aria-hidden
        className={cx(
          "absolute size-4 text-foreground-icon-secondary transition-all duration-200 ease-out",
          "group-hover:text-foreground-icon-primary",
          copied ? "scale-75 opacity-0 blur-[2px]" : "scale-100 opacity-100 blur-0",
        )}
      />
      <RiCheckLine
        aria-hidden
        className={cx(
          "absolute size-4 text-foreground-icon-secondary transition-all duration-200 ease-out",
          "group-hover:text-foreground-icon-primary",
          copied ? "scale-100 opacity-100 blur-0" : "scale-75 opacity-0 blur-[2px]",
        )}
      />
    </span>
  );
}

/**
 * Feedback actions under an assistant turn. Liking/disliking raises a small
 * toast (rendered by the caller through `onToast` so it can position itself
 * — e.g. over the generated image); copying swaps the glyph for a check.
 */
function FeedbackRow({ onToast }: { onToast?: (message: string) => void } = {}) {
  const [copied, setCopied] = useState(false);
  // The copy tooltip is controlled so the "Copied!" confirmation can stay up
  // after the click and then dismiss itself, even if the pointer never left
  // the button (hover alone would keep an uncontrolled tooltip open).
  const [copyTooltipOpen, setCopyTooltipOpen] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const copy = () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopied(true);
    setCopyTooltipOpen(true);
    copyTimer.current = setTimeout(() => {
      setCopied(false);
      setCopyTooltipOpen(false);
    }, 1600);
  };

  return (
    <div className="flex items-center gap-1.5">
      <FeedbackButton
        icon={RiThumbUpLine}
        label="Good response"
        onPress={() => onToast?.("Thanks for the feedback")}
      />
      <FeedbackButton
        icon={RiThumbDownLine}
        label="Bad response"
        onPress={() => onToast?.("Thanks — we'll use this to improve")}
      />
      <FeedbackButton
        label="Copy response"
        tooltip={copied ? "Copied!" : undefined}
        isTooltipOpen={copyTooltipOpen}
        onTooltipOpenChange={setCopyTooltipOpen}
        onPress={copy}
      >
        <FeedbackCopyGlyph copied={copied} />
      </FeedbackButton>
    </div>
  );
}

/** Assistant turn: 14/20 regular prose + feedback actions. Lines (direct
 *  children, authored as `Line`s) blur in staggered when the message loads. */
export function AssistantMessage({ children }: { children: ReactNode }) {
  return (
    <motion.div
      variants={MESSAGE_VARIANTS}
      initial="hidden"
      animate="visible"
      className="flex w-full flex-col gap-2 text-body-regular text-text-primary"
    >
      {children}
      <Line>
        <FeedbackRow />
      </Line>
    </motion.div>
  );
}

/** User turn: white radius/2xl card (p 12, card contact shadow), pushed to
 *  the right of the thread. Sizes to its content, capped at half the column
 *  plus the 6px bleed the composer has; the text inside stays left-aligned. */
export function UserMessage({ children }: { children: ReactNode }) {
  return (
    <motion.div
      variants={MESSAGE_VARIANTS}
      initial="hidden"
      animate="visible"
      className="-mr-1.5 ml-auto flex w-fit max-w-[calc(50%+6px)] flex-col rounded-2xl bg-background-primary-default px-3 py-[11px] text-left text-body-regular text-text-primary shadow-card"
    >
      {children}
    </motion.div>
  );
}

/** Inline attachment chip inside a user message (indigo link pill). */
function LinkChip({ children }: { children: string }) {
  return (
    <span className="-my-0.5 mr-1 inline-flex items-center justify-center gap-0.5 rounded-lg bg-indigo-100 px-1 py-[3px] align-middle">
      <RiLinkM className="size-4 shrink-0 text-indigo-500" aria-hidden />
      <span className="text-caption-2-medium whitespace-nowrap text-indigo-500">{children}</span>
    </span>
  );
}

/** Bulleted list — an orchestrator in the message stagger, so its items
 *  blur in one after another. */
function Bullets({ children }: { children: ReactNode }) {
  return (
    <motion.ul variants={MESSAGE_VARIANTS} className="flex list-disc flex-col gap-2 pl-[21px]">
      {children}
    </motion.ul>
  );
}

/** Bullet that blurs in as its own line within the message stagger. */
function Bullet({ children }: { children: ReactNode }) {
  return <motion.li variants={LINE_VARIANTS}>{children}</motion.li>;
}

/** The conversation, one entry per turn — revealed in 2s batches on mount. */
const LANDING_PAGE_MESSAGES: { id: string; node: ReactNode }[] = [
  {
    id: "a1",
    node: (
      <AssistantMessage>
        <Line>
          <p>Both changes are in:</p>
        </Line>
        <Bullets>
          <Bullet>
            <span className="font-medium">Sidebar PRO badge</span> — swapped the blue gradient
            for the minimal treatment: grey bg-background-tertiary-default with
            text-text-secondary. Since ProBadge is only used in the docs sidebar (the gallery
            cards have their own tier styling), this was a safe global restyle.
          </Bullet>
        </Bullets>
        <Line>
          <p>
            One implementation note: the framework tabs needed a small client wrapper
            (app/installation/framework-tabs.tsx) because icon components can&apos;t be passed
            from a server page across the client boundary — the step content itself stays
            server-rendered so componentSource still works.
          </p>
        </Line>
        <Line>
          <p>
            Verified: the page returns 200 on the dev server, the redirect works, and the full
            production build passes cleanly. Happy to push when you&apos;re ready.
          </p>
        </Line>
      </AssistantMessage>
    ),
  },
  {
    id: "u1",
    node: (
      <UserMessage>
        <Line>
          <p>
            make detail screens like this for home and medical profile templates:{" "}
            <LinkChip>figma.com/project/hse82s...</LinkChip> you can increase max width of the
            detail page for this case otherwise dashboard page wouldn&apos;t fit
          </p>
        </Line>
      </UserMessage>
    ),
  },
  {
    id: "a2",
    node: (
      <AssistantMessage>
        <Line>
          <p className="text-text-secondary">Worked for 5m 32s</p>
        </Line>
        <Line>
          <p>Both template detail pages are live, in the style defined in Figma.</p>
        </Line>
        <Bullets>
          <Bullet>
            <span className="font-medium">New pages</span> — /components/home-dashboard and
            /components/medical-profile, built with ComponentDetail: title and description, a
            scaled live preview of the full template (the actual DashboardShell / MedicalShell
            rendered at 80% inside a bordered frame, fully interactive), a &quot;Live
            template&quot; section linking to the full-size page under /templates/…, a
            &quot;What&apos;s included&quot; section listing everything in the package, and a
            Pro callout instead of install instructions.
          </Bullet>
          <Bullet>
            <span className="font-medium">Wider layout</span> — ComponentDetail now takes a
            wide prop that bumps the page shell from 1200px to 1560px (main column 900px →
            1220px), so the dashboards fit without heavy downscaling. Regular component pages
            are unchanged.
          </Bullet>
        </Bullets>
        <Line>
          <p>
            Both pages return 200 on the dev server and lints are clean. Take a look — happy to
            adjust the preview scale or frame height, and to push when you&apos;re ready.
          </p>
        </Line>
      </AssistantMessage>
    ),
  },
  {
    id: "u2",
    node: (
      <UserMessage>
        <Line>
          <p>
            looks great! add both templates to the docs sidebar under a new Templates group and
            push everything to main
          </p>
        </Line>
      </UserMessage>
    ),
  },
  {
    id: "a3",
    node: (
      <AssistantMessage>
        <Line>
          <p className="text-text-secondary">Worked for 1m 48s</p>
        </Line>
        <Line>
          <p>
            Done — the docs sidebar now has a <span className="font-medium">Templates</span> group
            listing Home Dashboard and Medical Profile with PRO badges, and the components gallery
            got a matching section. Everything is committed and pushed to main; the Vercel build
            went through cleanly.
          </p>
        </Line>
      </AssistantMessage>
    ),
  },
];

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** How long the mock generation runs — the canvas animation, the countdown
 *  and the reveal all read from this one number. */
const IMAGE_GENERATION_MS = 4000;

/**
 * Half of a flap card: the full glyph in a 16px line box, clipped to its top
 * or bottom 8px. The halves sit flush — no hairline between them, since at
 * rest a gap reads as a strikethrough struck through the digit rather than
 * as a seam. Separation only appears while a leaf is actually swinging.
 */
function FlapHalf({ digit, half }: { digit: string; half: "top" | "bottom" }) {
  return (
    <span className="block h-2 overflow-hidden bg-background-tertiary-default">
      <span
        className={cx(
          "block h-4 text-center leading-4 text-text-secondary tabular-nums",
          half === "bottom" && "-mt-2",
        )}
      >
        {digit}
      </span>
    </span>
  );
}

/**
 * One split-flap card, airport-departure-board style.
 *
 * Four layers hinged on the centre seam: the two STATIC halves behind hold
 * the new digit's top and the old digit's bottom — precisely the halves the
 * flip uncovers and buries — while two LEAVES swing over them. That's what
 * keeps the glyph continuous throughout; animating a single element would
 * show the digit changing mid-rotation.
 */
function FlapDigit({ digit }: { digit: string }) {
  // Derived during render rather than in an effect, so the outgoing digit is
  // captured in the same commit the new one arrives in — an effect would
  // land a frame late and the leaf would start from the wrong face.
  const [flip, setFlip] = useState({ settled: digit, from: digit, key: 0 });
  if (flip.settled !== digit) {
    setFlip({ settled: digit, from: flip.settled, key: flip.key + 1 });
  }
  const stale = flip.settled !== digit;
  const leaving = stale ? flip.settled : flip.from;
  const flipKey = stale ? flip.key + 1 : flip.key;

  return (
    <span
      aria-hidden
      className="relative block w-[11px] overflow-hidden rounded-[3px] bg-background-tertiary-default [perspective:70px]"
    >
      {/* Static: what the falling leaf reveals, and what the rising one covers */}
      <FlapHalf digit={digit} half="top" />
      <FlapHalf digit={leaving} half="bottom" />

      {/* Re-keying restarts both leaves together on every tick */}
      {flipKey > 0 && (
        <span key={flipKey} className="pointer-events-none absolute inset-0">
          <span className="animate-flap-fall absolute inset-x-0 top-0">
            <FlapHalf digit={leaving} half="top" />
          </span>
          <span className="animate-flap-rise absolute inset-x-0 bottom-0">
            <FlapHalf digit={digit} half="bottom" />
          </span>
        </span>
      )}
    </span>
  );
}

/** Countdown rendered as a row of flap cards — one per digit, keyed by
 *  position so each card flips in place the way a real board does. */
function FlapCountdown({ seconds }: { seconds: number }) {
  return (
    <span className="flex shrink-0 items-center gap-px">
      {String(seconds)
        .split("")
        // Keyed by position, not value: card N is a physical card that stays
        // put and flips, exactly like a board.
        .map((digit, index) => <FlapDigit key={index} digit={digit} />)}
      {/* The unit sits tight against the card — the flap's own side padding
          already reads as a gap, so any extra here detaches the "s". */}
      <span aria-hidden>s</span>
      {/* The halves each carry the whole glyph, so the cards would be read
          twice — announce the value once instead. */}
      <span className="sr-only">{seconds} seconds remaining</span>
    </span>
  );
}

export function ImageGenerationResponse({
  onGenerated,
  hideHeader = false,
  generatedImageSrc = "/ai-chat/generated-footballer.jpg",
  generatedImageAlt = "Vintage-style illustration of a football player in Argentina's striped kit",
}: {
  onGenerated?: () => void;
  hideHeader?: boolean;
  generatedImageSrc?: string;
  generatedImageAlt?: string;
} = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  // Whole seconds left, ticked from the same rAF clock that drives the
  // canvas so the label never drifts out of sync with the animation.
  const [secondsLeft, setSecondsLeft] = useState(IMAGE_GENERATION_MS / 1000);
  // Transient feedback toast over the image's bottom edge.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // Held in a ref so the generation effect stays mount-only — a changing
  // callback identity must not restart the canvas or the countdown.
  const onGeneratedRef = useRef(onGenerated);
  useEffect(() => {
    onGeneratedRef.current = onGenerated;
  }, [onGenerated]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const card = canvas?.parentElement;
    const context = canvas?.getContext("2d");
    if (!canvas || !card || !context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const startedAt = performance.now();
    let frame = 0;
    let stopped = false;
    let shownSecond = IMAGE_GENERATION_MS / 1000;

    // Everything below is hoisted OUT of the draw loop on purpose. The frame
    // unfolds (an animated height) at the same time this canvas runs, so a
    // per-frame getBoundingClientRect + getComputedStyle would force a style
    // and layout flush on every single frame of that animation — which is
    // exactly what made the push-up stutter. Geometry is re-read only when
    // the box actually changes, colors only a couple of times a second.
    let rect = card.getBoundingClientRect();
    let pendingResize = true;

    const observer = new ResizeObserver(() => {
      rect = card.getBoundingClientRect();
      pendingResize = true;
    });
    observer.observe(card);

    const applySize = () => {
      if (!pendingResize) return;
      pendingResize = false;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      // Assigning width/height resets the context, so the transform has to
      // be re-applied here rather than once up front.
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    // Both dot colors must be SEMANTIC so they invert with the theme. The
    // crest dots were on the raw `--color-neutral-100` scale (near-white),
    // which vanished against the white card in light mode; icon/primary
    // resolves dark on light and near-white on dark, keeping the same
    // contrast in both. The base dots' quaternary token already flips.
    const readColors = () => {
      const styles = getComputedStyle(card);
      return {
        active: styles.getPropertyValue("--color-foreground-icon-primary").trim(),
        neutral: styles.getPropertyValue("--color-foreground-icon-quaternary").trim(),
      };
    };
    let colors = readColors();
    let colorsReadAt = performance.now();

    const energyAt = (x: number, y: number, elapsedSeconds: number, aspect: number) => {
      const dx = (x - 0.5) * aspect;
      const dy = y - 0.5;
      const coordinate = Math.sqrt(dx * dx + dy * dy) / 0.5;
      const duration = 1.8 / 0.7;
      const sigma = 0.34 * 0.22;
      const newestAge = elapsedSeconds % 1.3;
      const visibleWaveCount = Math.ceil(duration / 1.3) + 1;
      let combined = 0;

      for (let wave = 0; wave < visibleWaveCount; wave += 1) {
        const age = newestAge + wave * 1.3;
        const progress = age / duration;
        if (progress > 1) continue;

        const distance = coordinate - progress;
        const ring = Math.exp(-(distance * distance) / (2 * sigma * sigma));
        const fadeIn = smoothstep(0, 0.1, progress);
        const fadeOut = 1 - smoothstep(0.62, 1, progress);
        combined += ring * fadeIn * fadeOut;
      }

      return Math.min(1, combined);
    };

    const draw = (now: number) => {
      if (stopped) return;

      applySize();
      const elapsed = now - startedAt;
      // Cheap enough to catch a theme flip, far too slow to cost anything.
      if (now - colorsReadAt > 500) {
        colors = readColors();
        colorsReadAt = now;
      }
      const { active, neutral } = colors;
      const spacing = 9;
      const columns = Math.ceil(rect.width / spacing) + 1;
      const rows = Math.ceil(rect.height / spacing) + 1;
      const offsetX = (rect.width - (columns - 1) * spacing) / 2;
      const offsetY = (rect.height - (rows - 1) * spacing) / 2;

      context.clearRect(0, 0, rect.width, rect.height);

      for (let row = 0; row < rows; row += 1) {
        const py = offsetY + row * spacing;
        const ny = py / rect.height;

        for (let column = 0; column < columns; column += 1) {
          const px = offsetX + column * spacing;
          const nx = px / rect.width;
          const energy = reduceMotion
            ? 0.24
            : energyAt(nx, ny, elapsed / 1000, rect.width / rect.height);
          const edgeFade = Math.min(1, nx * 7, (1 - nx) * 7, ny * 7, (1 - ny) * 7);
          const opacity = edgeFade * (0.08 + energy * 0.68 * 0.92);
          const radius = 1 * (0.72 + energy * 0.48);

          context.globalAlpha = opacity;
          context.fillStyle = energy > 0.22 ? active : neutral;
          context.beginPath();
          context.arc(px, py, radius, 0, Math.PI * 2);
          context.fill();
        }
      }

      context.globalAlpha = 1;

      // Tick the countdown off the same clock: ceil() keeps it showing "4s"
      // for the first second and lands on "1s" for the final one. Only push
      // to React when the whole second actually changes — setting state every
      // frame re-rendered this subtree (canvas, flaps, image) 60× a second on
      // top of the unfold animation.
      const remaining = Math.max(0, IMAGE_GENERATION_MS - elapsed);
      const nextSecond = Math.ceil(remaining / 1000);
      if (nextSecond !== shownSecond) {
        shownSecond = nextSecond;
        setSecondsLeft(nextSecond);
      }

      frame = window.requestAnimationFrame(draw);
    };

    frame = window.requestAnimationFrame(draw);

    const timer = window.setTimeout(() => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      setSecondsLeft(0);
      setReady(true);
      // Hand the finished image to the gallery panel, timed with the
      // reveal so the tile and the artwork land together.
      onGeneratedRef.current?.();
    }, IMAGE_GENERATION_MS);

    return () => {
      stopped = true;
      observer.disconnect();
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <motion.div
      variants={MESSAGE_VARIANTS}
      initial="hidden"
      animate="visible"
      className="flex w-full flex-col items-start gap-2"
    >
      {!hideHeader ? (
        <Line>
          <div className="flex w-[200px] items-baseline text-body-regular">
            {ready && <span className="text-text-primary">Image generated</span>}
          </div>
        </Line>
      ) : null}

      {/* The frame grows open from 0 → 250px instead of snapping to full
          height on mount. Because the thread is bottom-anchored, that growth
          pushes the message above it smoothly upward — the card looks like
          it's unfolding into the conversation rather than popping in.
          Its own initial/animate keeps it OUT of the parent's variant chain:
          inheriting would hand it the 180ms `staggerChildren` slot behind a
          sibling that renders nothing until ready, so the unfold sat still
          for a beat before starting. */}
      <motion.div
        variants={IMAGE_FRAME_VARIANTS}
        initial="hidden"
        animate="visible"
        className="w-[200px] overflow-hidden"
      >
        <div
          className="relative h-[250px] w-[200px] overflow-hidden rounded-2xl bg-background-primary-default shadow-card"
          aria-live="polite"
          aria-label={ready ? `Generated image: ${generatedImageAlt}` : "Generating image"}
        >
          <canvas
            ref={canvasRef}
            aria-hidden
            className={cx(
              "absolute inset-0 size-full transition-opacity duration-300",
              ready ? "opacity-0" : "opacity-100",
            )}
          />
          {/* In-frame status: shimmering label on the left, live countdown
              pinned opposite it as a split-flap board. */}
          <div
            className={cx(
              // Centered, not baseline-aligned: the flap card is
              // overflow-hidden, so its baseline is its bottom edge rather
              // than the digit's — baseline alignment floated the label ~4px
              // above the countdown.
              "absolute inset-x-3 bottom-3 flex items-center justify-between gap-3",
              "text-body-2-medium text-text-tertiary transition-opacity duration-300",
              ready ? "opacity-0" : "opacity-100",
            )}
          >
            <AgentProgressLoadingText>Generating image</AgentProgressLoadingText>
            <FlapCountdown seconds={secondsLeft} />
          </div>
          {/* Reveal uses an animated radial-gradient MASK rather than
              clip-path: a clip is binary, so its circle edge always lands
              hard-aliased. Sweeping two gradient stops (solid core →
              transparent, ~26% apart) feathers the boundary, so the image
              melts outward instead of being cut out. `--reveal` is the
              animated stop position; motion drives it as a plain custom
              property. */}
          <motion.div
            className="absolute inset-0"
            initial={false}
            animate={
              ready
                ? { opacity: 1, filter: "blur(0px)", "--reveal": "132%" }
                : { opacity: 0, filter: "blur(10px)", "--reveal": "0%" }
            }
            transition={{ duration: 1.55, ease: [0.4, 0, 0.2, 1] }}
            style={
              {
                "--reveal": "0%",
                maskImage:
                  "radial-gradient(circle at 50% 50%, #000 calc(var(--reveal) - 26%), transparent var(--reveal))",
                WebkitMaskImage:
                  "radial-gradient(circle at 50% 50%, #000 calc(var(--reveal) - 26%), transparent var(--reveal))",
              } as CSSProperties
            }
          >
            <Image
              src={generatedImageSrc}
              alt={generatedImageAlt}
              fill
              sizes="200px"
              className="object-cover"
            />
          </motion.div>

          {/* Feedback toast — sits over the image's bottom edge, rising in
              from 8px below and leaving the same way. */}
          <AnimatePresence>
            {toast && (
              <motion.div
                key={toast}
                role="status"
                initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                className={cx(
                  "absolute inset-x-3 bottom-3 rounded-lg px-2.5 py-1.5 text-center",
                  "bg-neutral-950/80 text-body-2-medium text-white backdrop-blur-sm",
                )}
              >
                {toast}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      {ready && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
        >
          <FeedbackRow onToast={showToast} />
        </motion.div>
      )}
    </motion.div>
  );
}

const imageGenerationMessages = (
  onGenerated?: () => void,
): { id: string; node: ReactNode }[] => [
  {
    id: "image-u1",
    node: (
      <UserMessage>
        <Line>
          <p>
            Create a vintage editorial illustration of Lionel Messi dribbling in
            Argentina&apos;s home kit against a blue background.
          </p>
        </Line>
      </UserMessage>
    ),
  },
  {
    id: "image-a1",
    node: <ImageGenerationResponse onGenerated={onGenerated} />,
  },
];

const CODING_RESPONSE_CODE = `const nextTheme = theme === "dark" ? "light" : "dark";

document.documentElement.classList.toggle(
  "dark",
  nextTheme === "dark",
);
localStorage.setItem("boardui:theme", nextTheme);`;

function CodingResponse() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const resetTimer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(resetTimer);
  }, [copied]);

  const copyCode = async () => {
    await navigator.clipboard.writeText(CODING_RESPONSE_CODE);
    setCopied(true);
  };

  return (
    <AssistantMessage>
      <Line>
        <p>
          Done — the semantic dark-mode tokens and reusable theme toggle are wired. The toggle
          updates the root theme from one place and persists the selection:
        </p>
      </Line>

      <Line>
        <div className="overflow-hidden rounded-2xl border border-separator-border bg-docs-code-background shadow-xs">
          <div className="flex h-9 items-center justify-between gap-3 border-b border-separator-border px-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="inline-flex h-3.5 items-center rounded-md border border-docs-file-chip-border bg-docs-file-chip-background px-1.5 font-mono text-[10px] leading-none font-medium text-docs-file-chip-foreground">
                TSX
              </span>
              <span className="truncate font-mono text-[12px] text-text-secondary">
                theme-toggle.tsx
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="flex items-center gap-1 font-mono text-[11px] leading-none">
                <span className="text-emerald-700">+156</span>
                <span className="text-red-600">-23</span>
              </div>
              <button
                type="button"
                aria-label={copied ? "Code copied" : "Copy code"}
                onClick={() => void copyCode()}
                className="group flex size-6 cursor-pointer items-center justify-center rounded-md outline-none transition-colors duration-150 hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
              >
                {copied ? (
                  <RiCheckLine className="size-3.5 text-lime-500" aria-hidden />
                ) : (
                  <RiFileCopyLine className="size-3.5 text-foreground-icon-secondary transition-colors duration-150 group-hover:text-foreground-icon-hover" aria-hidden />
                )}
              </button>
            </div>
          </div>

          <Highlight code={CODING_RESPONSE_CODE} language="tsx" theme={AI_CHAT_CODE_THEME}>
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[11px] leading-[18px] [scrollbar-width:thin]">
                <code className="block">
                  {tokens.map((line, index) => (
                    <span
                      key={index}
                      {...getLineProps({
                        line,
                        className: "flex min-w-max items-start gap-3",
                      })}
                    >
                      <span className="w-3 shrink-0 select-none text-right text-text-tertiary">
                        {index + 1}
                      </span>
                      <span className="whitespace-pre">
                        {line.map((token, tokenIndex) => {
                          const tokenProps = getTokenProps({ token });

                          if (token.content.includes("nextTheme")) {
                            return (
                              <span key={tokenIndex} {...tokenProps}>
                                {token.content.split(/(nextTheme)/g).map((part, partIndex) =>
                                  part === "nextTheme" ? (
                                    <span key={partIndex} style={{ color: "#00bc7d" }}>
                                      {part}
                                    </span>
                                  ) : (
                                    part
                                  ),
                                )}
                              </span>
                            );
                          }

                          return (
                            <span key={tokenIndex} {...tokenProps} />
                          );
                        })}
                      </span>
                    </span>
                  ))}
                </code>
              </pre>
            )}
          </Highlight>
        </div>
      </Line>

    </AssistantMessage>
  );
}

const CODING_SCENARIO_MESSAGES: { id: string; node: ReactNode }[] = [
  {
    id: "coding-u1",
    node: (
      <UserMessage>
        <Line>
          <p>
            update our color tokens for dark mode and add a reusable theme toggle to the
            registry. run lint and a production build when you&apos;re done.
          </p>
        </Line>
      </UserMessage>
    ),
  },
];

export type AiChatScenario = "landing-page-design" | "image-generation" | "coding-scenario";

/** Scrollable thread that soft-loads the conversation: the first message
 *  mounts immediately, then one more every 2s, each blurring in line by
 *  line. Follows the newest message with a smooth scroll. */
function Thread({
  scenario,
  onImageGenerated,
  onWorkingChange,
}: {
  scenario: AiChatScenario;
  onImageGenerated?: () => void;
  /** True while the coding scenario's agent progress is running — the
   *  container lights the composer up for the duration. */
  onWorkingChange?: (working: boolean) => void;
}) {
  const [codingFinished, setCodingFinished] = useState(false);
  const handleCodingFinished = useCallback(() => setCodingFinished(true), []);
  const codingMessages: { id: string; node: ReactNode }[] = [
    ...CODING_SCENARIO_MESSAGES,
    {
      id: "coding-work",
      node: (
        <AnimatePresence mode="wait">
          {codingFinished ? (
            <motion.div
              key="coding-response"
              initial={{ opacity: 0, y: 8, filter: "blur(7px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
            >
              <CodingResponse />
            </motion.div>
          ) : (
            <motion.div
              key="coding-steps"
              initial={{ opacity: 1 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, y: -6, height: 0, filter: "blur(6px)" }}
              transition={{ duration: 0.28, ease: [0.4, 0, 1, 1] }}
              className="overflow-hidden"
            >
              <AgentProgress onFinished={handleCodingFinished} />
            </motion.div>
          )}
        </AnimatePresence>
      ),
    },
  ];
  const messages =
    scenario === "image-generation"
      ? imageGenerationMessages(onImageGenerated)
      : scenario === "coding-scenario"
        ? codingMessages
        : LANDING_PAGE_MESSAGES;
  const [visibleCount, setVisibleCount] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visibleCount >= messages.length) return;
    const delay = scenario === "landing-page-design" ? 2000 : 900;
    const timer = setTimeout(() => setVisibleCount((count) => count + 1), delay);
    return () => clearTimeout(timer);
  }, [messages.length, scenario, visibleCount]);

  // The agent is "working" from the moment the progress block appears until
  // it reports finished.
  const working =
    scenario === "coding-scenario" && visibleCount >= codingMessages.length && !codingFinished;
  useEffect(() => {
    onWorkingChange?.(working);
    return () => onWorkingChange?.(false);
  }, [working, onWorkingChange]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || visibleCount <= 1) return;

    // On completion, wait for the steps exit (280ms) before following the
    // newly mounted code response.
    const scrollTimer = window.setTimeout(
      () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }),
      codingFinished ? 320 : 0,
    );
    return () => window.clearTimeout(scrollTimer);
  }, [codingFinished, visibleCount]);

  return (
    <div
      ref={scrollRef}
      // justify-end anchors the thread to the bottom of the viewport so a
      // short conversation sits just above the composer and grows upward,
      // the way a real chat reads (it has no effect once the content
      // overflows and the container starts scrolling).
      className="flex min-h-0 w-full flex-1 flex-col justify-end gap-3 overflow-y-auto px-4 pt-4 [scrollbar-width:thin]"
    >
      {messages.slice(0, visibleCount).map((message) => (
        <div key={message.id}>{message.node}</div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- container */

export function AiChatContainer({
  className,
  scenario = "landing-page-design",
  onImageGenerated,
  mobileHeader,
}: {
  className?: string;
  scenario?: AiChatScenario;
  mobileHeader?: ReactNode;
  /** Fires when the image-generation thread finishes rendering its image,
   *  so the shell can add it to the gallery panel. */
  onImageGenerated?: () => void;
} = {}) {
  const [agentWorking, setAgentWorking] = useState(false);
  const chatTitle =
    scenario === "image-generation"
      ? "image generation"
      : scenario === "coding-scenario"
        ? "coding scenario"
        : "landing page design";

  return (
    <section
      className={cx(
        "flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-3xl bg-background-secondary-default",
        className,
      )}
    >
      {mobileHeader}

      {/* Header — project › chat breadcrumb + share/more */}
      <header className="flex w-full items-center justify-between gap-2 px-4 pt-4">
        <Breadcrumb aria-label="Chat location" className="min-w-0 flex-1">
          <BreadcrumbItem icon={RiFolderLine}>vibl coding project</BreadcrumbItem>
          <BreadcrumbItem current>{chatTitle}</BreadcrumbItem>
        </Breadcrumb>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" aria-label="Share chat" className="group cursor-pointer outline-none">
            <RiShare2Line
              className="size-4 text-foreground-icon-secondary transition-colors duration-150 group-hover:text-foreground-icon-hover group-focus-visible:text-foreground-icon-hover"
              aria-hidden
            />
          </button>
          <button type="button" aria-label="More options" className="group cursor-pointer outline-none">
            <RiMoreFill
              className="size-4 text-foreground-icon-secondary transition-colors duration-150 group-hover:text-foreground-icon-hover group-focus-visible:text-foreground-icon-hover"
              aria-hidden
            />
          </button>
        </div>
      </header>

      {/* Thread */}
      <Thread
        key={scenario}
        scenario={scenario}
        onImageGenerated={onImageGenerated}
        onWorkingChange={setAgentWorking}
      />

      {/* Composer + status bar — lit while the agent works, dimming back
          once the progress block completes. */}
      <div className="flex w-full flex-col gap-2.5 px-2.5 pt-3 pb-2.5">
        {agentWorking && <AgentThinking variant="infinity" className="px-1.5" />}
        <ComposerLoader active={agentWorking}>
          <GlassComposer glass={agentWorking} />
        </ComposerLoader>
        <div className="px-1.5">
          <StatusBar />
        </div>
      </div>
    </section>
  );
}
