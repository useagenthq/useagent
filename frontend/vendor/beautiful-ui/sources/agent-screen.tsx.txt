"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/atoms/Button";

/* ─────────────────────────────────────────────────────────
 * AGENT SCREEN (live viewer)
 * Watch an agent work. The resting card is a framed capture of
 * the agent's screen; hover reveals an "Open" pill (the blue
 * accent Button). Open expands to a full-width viewer where you
 * can "Teach a task" — which starts recording — collapse
 * (recording keeps running, the card shows a red REC badge), and
 * end it.
 *
 * The screen is a placeholder image by default; pass a `streamSrc`
 * (image or video URL) to pipe in a real stream.
 * ───────────────────────────────────────────────────────── */

const PLACEHOLDER = "https://95dnc2a95qgwt9ff.public.blob.vercel-storage.com/agent-desktop-v3.png";

/* aspect ratio of the placeholder capture (2964×1856) — used so the collapsed
 * card shows the whole desktop with no crop */
const SCREEN_ASPECT = "aspect-[2964/1856]";

function Ico({ path, size = 15, sw = 2 }: { path: React.ReactNode; size?: number; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {path}
    </svg>
  );
}

/* minimize-2 — two arrows converging to the middle (collapse) */
const collapseIcon = (
  <>
    <polyline points="4 14 10 14 10 20" />
    <polyline points="20 10 14 10 14 4" />
    <line x1="14" y1="10" x2="21" y2="3" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </>
);

/* maximize-2 — two arrows out to opposite corners (open) */
const openIcon = (
  <>
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </>
);

function fmt(total: number) {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* macOS-style pointer */
function CursorSvg({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} width="30" height="30" viewBox="0 0 24 24" fill="#111318" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
      <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
    </svg>
  );
}

/* collapsed card: a static decorative cursor sitting on the capture */
function DriftCursor() {
  return <CursorSvg className="agent-cursor" style={{ left: "42%", top: "53%" }} />;
}

/* the agent's screen — a real stream via streamSrc, else a faux window.
 * Media is absolutely positioned so it always fills its (relative) parent —
 * an h-full chain through an aspect-ratio box can collapse and leak the bg. */
function Screen({ streamSrc, cursor = true }: { streamSrc?: string; cursor?: boolean }) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-inset">
      {streamSrc ? (
        /\.(mp4|webm|mov|m4v)(\?|$)/i.test(streamSrc) ? (
          <video src={streamSrc} autoPlay muted loop playsInline className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={streamSrc} alt="" className="absolute inset-0 h-full w-full object-cover" />
        )
      ) : (
        <FauxWindow />
      )}
      {cursor && <DriftCursor />}
    </div>
  );
}

/* expanded viewer media — the image sizes itself within the viewport (bounded
 * by width and height) so the whole screen always fits with no crop */
function MediaSizer({ src }: { src: string }) {
  const style = { maxHeight: "calc(100vh - 150px)", maxWidth: "min(960px, 90vw)" } as const;
  const cls = "block h-auto w-auto object-contain";
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(src) ? (
    <video src={src} autoPlay muted loop playsInline className={cls} style={style} />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className={cls} style={style} />
  );
}

/* connecting state — spinner on black, same ring as Task Rows */
function LoadingScreen() {
  const size = 26,
    stroke = 2,
    r = (size - stroke) / 2,
    c = 2 * Math.PI * r;
  return (
    <div className="absolute inset-0 bg-black">
      {/* spinner dead-center; wrapper carries the centering so the spin
          transform on the svg doesn't override it */}
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <svg width={size} height={size} className="block" style={{ animation: "spin 1.1s linear infinite" }} aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={stroke} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#fff" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * 0.28} ${c * 0.72}`} />
        </svg>
      </span>
      <span
        className="absolute inset-x-0 text-center text-[12.5px] font-medium text-white/70"
        style={{ top: "calc(50% + 28px)" }}
      >
        Connecting to agent&apos;s screen
      </span>
    </div>
  );
}

function FauxWindow() {
  return (
    <div className="flex h-full w-full flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-inset px-2.5 py-1.5">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-red" />
          <span className="size-2 rounded-full bg-orange" />
          <span className="size-2 rounded-full bg-green" />
        </span>
        <span className="ml-1 flex min-w-0 items-center gap-1.5 rounded-t-[6px] bg-surface px-2 py-1 shadow-[0_-1px_0_var(--line)]">
          <span className="size-2 shrink-0 rounded-[3px] bg-accent-tint" />
          <span className="h-1.5 w-14 rounded-full bg-line-strong" />
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-1.5 text-ink-3">
        <Ico size={12} path={<path d="M15 18l-6-6 6-6" />} />
        <Ico size={12} path={<path d="M9 6l6 6-6 6" />} />
        <span className="min-w-0 flex-1 truncate rounded-full bg-field px-2.5 py-[3px] font-mono text-[9px] text-ink-3">
          hunter.io/try/search/ugly.cash
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2.5 overflow-hidden p-3">
        <div className="flex items-center gap-2">
          <span className="grid size-4 place-items-center rounded-[4px] bg-accent-tint text-[8px] font-bold text-accent">h</span>
          <span className="h-1.5 w-12 rounded-full bg-line-strong" />
          <span className="ml-auto h-4 w-12 rounded-full bg-inset shadow-btn" />
        </div>
        <div className="flex items-center gap-2 rounded-[8px] bg-inset p-2">
          <span className="h-3 flex-1 rounded-full bg-surface shadow-hairline" />
          <span className="h-3 w-9 rounded-full bg-accent" />
        </div>
        {["w-2/5", "w-1/2", "w-1/3", "w-2/5"].map((w, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <span className="size-6 shrink-0 rounded-full bg-accent-tint" />
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className={`h-1.5 rounded-full bg-line-strong ${w}`} />
              <span className="h-1.5 w-3/5 rounded-full bg-line" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AgentScreen({
  agentName = "Agent",
  streamSrc = PLACEHOLDER,
  variant,
}: {
  agentName?: string;
  streamSrc?: string;
  variant?: string;
} = {}) {
  const loading = variant === "Loading";
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => setMounted(true), []);

  // tick while recording — survives collapse (state lives here, not the overlay)
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  // lock scroll + Esc-to-collapse while the viewer is open
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const startRecording = () => {
    setSecs(0);
    setRecording(true);
  };
  const endRecording = () => {
    setRecording(false);
    setSecs(0);
  };

  const controls = (
    <div className="flex shrink-0 items-center gap-1.5">
      {recording ? (
        <button
          type="button"
          onClick={endRecording}
          className="inline-flex h-[27px] items-center gap-1.5 rounded-full bg-red pl-2.5 pr-3 text-[13px] font-medium leading-none text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] transition-[transform,filter] duration-150 ease-out hover:brightness-95 active:scale-[0.96]"
        >
          <span className="size-2.5 rounded-[2px] bg-white" />
          End
        </button>
      ) : (
        <Button variant="secondary" size="sm" className="gap-1 pl-1.5" onClick={startRecording}>
          <Ico size={15} path={<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" /></>} />
          Teach a task
        </Button>
      )}
      <button
        type="button"
        aria-label="Collapse"
        onClick={() => setOpen(false)}
        className="primitive-icon-button text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
      >
        <Ico size={15} path={collapseIcon} />
      </button>
    </div>
  );

  return (
    <div className="w-full max-w-[340px]">
      {/* ── resting card — hover/click scoped to the Mac window only ── */}
      <div
        className={`group/screen relative ${SCREEN_ASPECT} overflow-hidden rounded-window bg-inset shadow-card transition-shadow duration-150 ${
          loading ? "" : "cursor-pointer hover:shadow-raised"
        }`}
        onClick={loading ? undefined : () => setOpen(true)}
        style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        {loading ? (
          <LoadingScreen />
        ) : (
          <>
            <Screen streamSrc={streamSrc} />

            {/* hover reveal — scoped to this frame's named group, not the gallery section */}
            <div className="absolute inset-0 flex items-center justify-center bg-[rgba(17,19,24,0)] transition-colors duration-150 group-hover/screen:bg-[rgba(17,19,24,0.18)]">
              <span className="translate-y-1 opacity-0 transition duration-150 group-hover/screen:translate-y-0 group-hover/screen:opacity-100">
                <Button
                  variant="accent"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(true);
                  }}
                >
                  <Ico size={14} path={openIcon} />
                  Open
                </Button>
              </span>
            </div>
          </>
        )}
      </div>

      <div className="mt-2.5 truncate px-0.5 text-[13px] font-medium text-ink">{agentName}&apos;s screen</div>

      {/* ── expanded viewer — portaled to <body> so it takes over the whole page ── */}
      {open &&
        mounted &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
            role="dialog"
            aria-modal="true"
            aria-label={`${agentName}'s screen`}
          >
            <div
              className="absolute inset-0 bg-black/60 dark:bg-black/75"
              style={{ animation: "fade-in 180ms ease-out both" }}
              onClick={() => setOpen(false)}
            />
            <div
              className="relative flex max-h-full flex-col overflow-hidden rounded-[16px] bg-surface p-2 pt-0 shadow-overlay"
              style={{ animation: "pop-in 240ms cubic-bezier(0.23,1,0.32,1) both" }}
            >
              {/* title bar — agent name far left, controls right */}
              <div className="flex h-11 shrink-0 items-center justify-between gap-3 px-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-ink">{agentName}</span>
                  {recording && (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-red-tint py-0.5 pl-1.5 pr-2 text-[11.5px] font-medium tabular-nums text-red">
                      <span className="size-2 rounded-full bg-red" style={{ animation: "records-pulse 1.1s ease-in-out infinite" }} />
                      {fmt(secs)}
                    </span>
                  )}
                </div>
                {controls}
              </div>

              {/* the screen — inset with a little padding (the crop framing);
                  the image sizes the window so the whole screen fits */}
              <div
                className="relative min-h-0 overflow-hidden rounded-[8px] bg-inset [cursor:none]"
                onMouseMove={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setCursorPos({ x: e.clientX - r.left, y: e.clientY - r.top });
                }}
                onMouseLeave={() => setCursorPos(null)}
              >
                {loading ? (
                  <div className={SCREEN_ASPECT} style={{ width: "min(960px, 90vw)" }}>
                    <LoadingScreen />
                  </div>
                ) : (
                  <MediaSizer src={streamSrc} />
                )}
                {!loading && cursorPos && (
                  <CursorSvg
                    className="pointer-events-none absolute z-10"
                    style={{ left: cursorPos.x, top: cursorPos.y, filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,0.35))" }}
                  />
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
