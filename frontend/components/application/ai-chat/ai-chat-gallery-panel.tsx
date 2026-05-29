"use client";

import Image from "next/image";
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { motion } from "motion/react";
import {
  RiCollapseDiagonalLine,
  RiDownload2Line,
  RiExpandDiagonalSLine,
  RiGalleryLine,
  RiImageAddLine,
  RiMore2Fill,
  RiSideBarLine,
  RiSparkling2Line,
} from "@remixicon/react";
import { Focusable } from "react-aria-components";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { cx } from "@/utils/cx";

/**
 * Right-hand panel for the image-generation template — the gallery
 * counterpart to `AiChatCodePanel`. Deliberately shares that panel's shell
 * so the two are interchangeable: same 410px column, same `pt-2` + 10px
 * gap rhythm, the same 30px pill-tab / panel-action header row.
 *
 * Content is a 3-up grid of past generations. Tiles are placeholders for
 * now (a soft gradient wash + prompt caption); swapping in real files means
 * giving each `GENERATIONS` entry a `src` — the tile already renders one
 * when present.
 */

export interface Generation {
  id: string;
  prompt: string;
  /** Artwork under /public/ai-chat/gallery. Falls back to a tinted
   *  placeholder while a file is missing, so the grid never breaks. */
  src?: string;
  /** Placeholder tint so the grid reads as varied rather than uniform. */
  tint: string;
  /** Intrinsic aspect ratio — what gives the masonry its uneven rhythm. */
  ratio: string;
}

/**
 * Gallery contents. Drop artwork into `public/ai-chat/gallery/` and point a
 * row's `src` at it; `ratio` should match the file's own proportions so the
 * masonry flow stays natural (the image itself always fills its tile via
 * object-cover, so a mismatch just crops).
 */
const GENERATIONS: Generation[] = [
  { id: "goldfish-living-room", prompt: "Goldfish living room, surreal collage", tint: "from-chart-6/25 to-chart-5/25", ratio: "1120/2000" },
  { id: "racing-suit", prompt: "Racing suit editorial, metallic green", tint: "from-chart-2/25 to-chart-7/25", ratio: "1120/2000" },
  { id: "hoopoes", prompt: "Hoopoes in olive branches, gouache", tint: "from-chart-8/25 to-chart-3/25", ratio: "1333/2000" },
  { id: "biker-rest", prompt: "Biker resting, watercolour manga", tint: "from-chart-1/25 to-chart-4/25", ratio: "1120/2000" },
  { id: "helmet-portraits", prompt: "Helmet portraits, risograph grid", tint: "from-chart-4/25 to-chart-1/25", ratio: "1497/2000" },
  { id: "cloud-crown", prompt: "Cloud crown, editorial portrait", tint: "from-chart-6/25 to-chart-4/25", ratio: "1333/2000" },
  { id: "nairobi-vibes", prompt: "Nairobi Vibes, blackletter poster", tint: "from-chart-2/25 to-chart-5/25", ratio: "928/1232" },
  { id: "beach-kid", prompt: "Beach kid, 35mm flash", tint: "from-chart-3/25 to-chart-8/25", ratio: "960/1200" },
  { id: "reader-pink", prompt: "Reader on pink, crayon texture", tint: "from-chart-3/25 to-chart-2/25", ratio: "1/1" },
  { id: "cat-with-beer", prompt: "Cat with a beer, bold linework", tint: "from-chart-8/25 to-chart-2/25", ratio: "928/1232" },
  { id: "perfume-still-life", prompt: "Perfume still life, grainy neon", tint: "from-chart-5/25 to-chart-6/25", ratio: "1120/2000" },
  { id: "linen-campaign", prompt: "Linen campaign, crimson backdrop", tint: "from-chart-3/25 to-chart-1/25", ratio: "1/1" },
  { id: "girls-and-blooms", prompt: "Girls and blooms, painterly crop", tint: "from-chart-3/25 to-chart-5/25", ratio: "896/1344" },
  { id: "ronin-red", prompt: "Ronin in red, cel-shaded", tint: "from-chart-3/25 to-chart-8/25", ratio: "1120/2000" },
  { id: "yellow-cabs", prompt: "Yellow cabs, palette-knife oil", tint: "from-chart-8/25 to-chart-4/25", ratio: "1497/2000" },
  { id: "green-ape", prompt: "Green ape, screenprint halftone", tint: "from-chart-7/25 to-chart-2/25", ratio: "1/1" },
  { id: "hanok-bookshop", prompt: "Hanok bookshop, pastel duotone", tint: "from-chart-6/25 to-chart-4/25", ratio: "928/1232" },
  { id: "underwater-highway", prompt: "Underwater highway, flat vector", tint: "from-chart-4/25 to-chart-1/25", ratio: "1120/2000" },
  { id: "massive-box", prompt: "MASSIV3 packaging, studio mockup", tint: "from-chart-6/25 to-chart-1/25", ratio: "1120/2000" },
  { id: "bloom-swirl", prompt: "Bloom swirl, impasto abstraction", tint: "from-chart-2/25 to-chart-8/25", ratio: "1/1" },
].map((g) => ({ ...g, src: `/ai-chat/gallery/${g.id}.webp` }));

/** Deterministic shuffle (mulberry32, same recipe as the tables' mock data)
 *  so the wall looks scattered rather than sorted, while staying stable
 *  between server and client — `Math.random` here would desync hydration. */
function shuffled<T>(items: T[], seed: number): T[] {
  let a = seed;
  const rng = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const WALL = shuffled(GENERATIONS, 11);

/** Relative tile height for one unit of width — drives column balancing. */
function ratioHeight(ratio: string) {
  const [w, h] = ratio.split("/").map(Number);
  return h / w;
}

/** radius/2lg — kept as a number so motion can correct it while a tile
 *  scales (see the tile's inline style). */
const TILE_RADIUS = 10;

/** A wall item plus its place in the load-in cascade. */
type Placed = Generation & { order: number };

/**
 * Split the wall into explicit columns, always filling the currently
 * shortest one. Explicit columns (rather than CSS `columns-3`) are what
 * make insertion animatable: prepending only shifts the column it lands
 * in, so the rest of the wall stays put instead of reflowing everywhere.
 *
 * Each item also gets an `order` for the entrance stagger. Column position
 * alone won't do — a masonry column is a vertical list, so staggering by it
 * would fill column 1 top to bottom before column 2 started. Sorting by the
 * tile's actual vertical offset (ties left to right) gives the diagonal
 * top-left → bottom-right sweep instead.
 */
function distribute(items: Generation[], columnCount = 3): Placed[][] {
  const columns: Placed[][] = Array.from({ length: columnCount }, () => []);
  const heights = new Array<number>(columnCount).fill(0);
  const placed: { item: Generation; column: number; top: number }[] = [];

  for (const item of items) {
    const shortest = heights.indexOf(Math.min(...heights));
    placed.push({ item, column: shortest, top: heights[shortest] });
    heights[shortest] += ratioHeight(item.ratio);
  }

  const order = new Map<string, number>();
  [...placed]
    .sort((a, b) => a.top - b.top || a.column - b.column)
    .forEach((entry, index) => order.set(entry.item.id, index));

  for (const entry of placed) {
    columns[entry.column].push({ ...entry.item, order: order.get(entry.item.id) ?? 0 });
  }
  return columns;
}

/** Header action — matches the code panel's icon buttons exactly. */
function PanelAction({
  icon: Icon,
  label,
}: {
  icon: typeof RiSideBarLine;
  label: string;
}) {
  return (
    <TooltipTrigger delay={200}>
      <Focusable>
        <button
          type="button"
          aria-label={label}
          className="group flex cursor-pointer items-center rounded-md p-0.5 transition-colors duration-150 ease hover:bg-background-primary-hover"
        >
          <Icon
            className="size-[18px] text-foreground-icon-secondary transition-colors duration-150 ease group-hover:text-foreground-icon-primary"
            aria-hidden
          />
        </button>
      </Focusable>
      <Tooltip size="sm">{label}</Tooltip>
    </TooltipTrigger>
  );
}

/** One generation: a tile at its own aspect ratio (that variance is what
 *  makes the masonry flow), with a hover scrim carrying quick actions and
 *  the prompt revealed along the bottom. `break-inside-avoid` keeps a tile
 *  from being split across the CSS columns. */
function GenerationTile({
  generation,
  isNew = false,
  order = 0,
  isExpanded = false,
  skipEntrance = false,
  isFlying = false,
  onToggle,
  onSettled,
}: {
  generation: Generation;
  isNew?: boolean;
  /** Place in the load-in cascade — ignored for freshly generated tiles,
   *  which arrive long after the wall has settled. */
  order?: number;
  /** Lifted out of its column and rendered across the full grid width. */
  isExpanded?: boolean;
  /** Suppresses the page-load entrance. Expanding remounts the tile under a
   *  new parent, and replaying a fade-from-blur there would break the
   *  illusion that it's one image changing size. */
  skipEntrance?: boolean;
  /** Mid-morph — lifted above the rest of the wall until it lands. */
  isFlying?: boolean;
  onToggle: () => void;
  /** Fired when the morph finishes, so the panel can drop this tile back
   *  into the normal stacking order. */
  onSettled?: () => void;
}) {
  const ease = [0.22, 1, 0.36, 1] as const;
  const delay = isNew ? 0 : order * 0.13;

  return (
    <motion.figure
      // `layoutId` rather than plain `layout`: expanding moves this tile to a
      // different parent (out of its column, into the full-width slot), so
      // React unmounts and remounts it. A shared id is what lets motion treat
      // those as the same element and morph the box instead of cross-fading.
      // It covers the plain-`layout` case too, so neighbours still glide.
      layoutId={`gallery-${generation.id}`}
      // A new tile only fades and un-blurs — no scale. The wall is already
      // moving underneath it, and a second motion on top reads as busy. On
      // load, though, nothing else is moving, so the wall's own tiles get
      // the scale as well.
      initial={
        skipEntrance
          ? // Explicitly opaque, not `false`. A shared `layoutId` pair
            // cross-fades by default — the tile would mount at opacity 0 and
            // fade up while it grew, which reads as two images swapping
            // rather than one image resizing. Declaring the start state
            // outright suppresses that ramp.
            { opacity: 1, scale: 1, filter: "blur(0px)" }
          : isNew
            ? { opacity: 0, filter: "blur(8px)" }
            : { opacity: 0, scale: 0.95, filter: "blur(8px)" }
      }
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      transition={{
        // The expand/collapse morph is a bigger move than a wall reflow, so
        // it gets a little longer to land.
        layout: { duration: isExpanded ? 0.6 : 0.55, ease },
        // Fade and blur resolve before the scale finishes, so each tile is
        // fully readable by the time it stops moving.
        opacity: { duration: 0.4, delay, ease },
        filter: { duration: 0.4, delay, ease },
        scale: { duration: 0.55, delay, ease },
      }}
      onLayoutAnimationComplete={onSettled}
      className="group relative block overflow-hidden"
      // Clipping and radius live on the element that actually scales, and the
      // radius is inline rather than `rounded-2lg` so motion owns the value:
      // it rewrites it as a percentage each frame to hold the corner at a
      // constant 10px while the box grows. As a class it would render at 3px
      // at the start of the morph and snap open.
      //
      // There is deliberately NO second `layout` element inside. Both tile
      // sizes use the image's own aspect ratio, so the morph is a uniform
      // scale with no distortion to correct — and a nested projection just
      // fights the parent's, which showed up as the inner box sliding.
      // The tile in motion always paints above the wall. Without this it flies
      // UNDER any tile that comes later in DOM order — a tile from column 1
      // growing across the grid would slide behind columns 2 and 3.
      style={{ borderRadius: TILE_RADIUS, zIndex: isExpanded || isFlying ? 30 : undefined }}
    >
      <div
        className="relative w-full bg-background-secondary-default"
        style={{ aspectRatio: generation.ratio }}
      >
        {generation.src ? (
          // `fill` + object-cover so artwork always covers its tile edge to
          // edge regardless of the file's own proportions.
          <Image
            src={generation.src}
            alt={generation.prompt}
            fill
            sizes={isExpanded ? "400px" : "140px"}
            className={cx(
              "object-cover transition-transform duration-300 ease-out",
              // The lift-on-hover is a grid affordance; once a tile is
              // expanded it's the subject, not a target.
              !isExpanded && "group-hover:scale-[1.03]",
            )}
          />
        ) : (
          // Placeholder: soft diagonal wash + a faint glyph, so the grid
          // reads as populated before real images land.
          <div
            className={cx(
              "flex size-full items-center justify-center bg-linear-to-br",
              generation.tint,
            )}
          >
            <RiImageAddLine className="size-5 text-foreground-icon-quaternary" aria-hidden />
          </div>
        )}

        {/* Full-bleed click target. A SIBLING of the action buttons rather
            than their parent — wrapping them would nest buttons, which is
            invalid. The scrim above is pointer-events-none, so clicks fall
            through to this except on the actions themselves. */}
        <button
          type="button"
          onClick={onToggle}
          aria-label={
            isExpanded ? `Minimize ${generation.prompt}` : `Enlarge ${generation.prompt}`
          }
          aria-expanded={isExpanded}
          className={cx(
            "absolute inset-0 outline-none",
            "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring",
            isExpanded ? "cursor-zoom-out" : "cursor-zoom-in",
          )}
        />

        {/* Hover scrim: actions top-right, prompt along the bottom — the
            caption lives inside the tile so masonry spacing stays even. */}
        <div
          className={cx(
            "pointer-events-none absolute inset-0 flex flex-col justify-between",
            isExpanded ? "p-2.5" : "p-1.5",
            "bg-linear-to-b from-neutral-950/40 via-transparent to-neutral-950/55",
            "opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100",
          )}
        >
          <span className="pointer-events-auto flex justify-end gap-1">
            {isExpanded && (
              <button
                type="button"
                onClick={onToggle}
                aria-label={`Minimize ${generation.prompt}`}
                className="flex cursor-pointer items-center rounded-md bg-neutral-950/45 p-1 backdrop-blur-sm transition-colors hover:bg-neutral-950/65"
              >
                <RiCollapseDiagonalLine className="size-3.5 text-white" aria-hidden />
              </button>
            )}
            <button
              type="button"
              aria-label={`Download ${generation.prompt}`}
              className="flex cursor-pointer items-center rounded-md bg-neutral-950/45 p-1 backdrop-blur-sm transition-colors hover:bg-neutral-950/65"
            >
              <RiDownload2Line className="size-3.5 text-white" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`More actions for ${generation.prompt}`}
              className="flex cursor-pointer items-center rounded-md bg-neutral-950/45 p-1 backdrop-blur-sm transition-colors hover:bg-neutral-950/65"
            >
              <RiMore2Fill className="size-3.5 text-white" aria-hidden />
            </button>
          </span>
          <figcaption
            className={cx(
              "px-0.5 text-white",
              isExpanded ? "text-body-medium" : "line-clamp-2 text-body-2-regular",
            )}
          >
            {generation.prompt}
          </figcaption>
        </div>
      </div>
    </motion.figure>
  );
}

export function AiChatGalleryPanel({
  className,
  width = 410,
  generated,
}: {
  className?: string;
  width?: CSSProperties["width"];
  /** Freshly generated images, newest first — they land at the top-left of
   *  the wall and push the rest of that column down. */
  generated?: Generation[];
} = {}) {
  const [tab, setTab] = useState<"gallery" | "styles">("gallery");

  // Generated images are pinned to the head of column 0 rather than fed
  // through `distribute`, so a new one always lands top-left no matter how
  // the balancer would otherwise place it.
  const columns = useMemo(() => {
    const base = distribute(WALL);
    if (!generated?.length) return base;
    return base.map((column, index) =>
      index === 0 ? [...generated.map((g) => ({ ...g, order: 0 })), ...column] : column,
    );
  }, [generated]);

  const generatedIds = useMemo(
    () => new Set((generated ?? []).map((g) => g.id)),
    [generated],
  );

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const expanded = useMemo(
    () => (expandedId ? (columns.flat().find((g) => g.id === expandedId) ?? null) : null),
    [columns, expandedId],
  );

  // The expanded tile is only REMOVED from its column — the wall is not
  // re-packed around it. Re-running `distribute` on the remaining 20 would
  // reshuffle most of them into different columns, and every one of those
  // would animate at once. Filtering means only the tiles below it in its own
  // column move, and the rest of the wall simply slides down under the hero.
  const visibleColumns = useMemo(
    () =>
      expandedId ? columns.map((column) => column.filter((g) => g.id !== expandedId)) : columns,
    [columns, expandedId],
  );

  // Tiles that have been expanded or collapsed at least once. Toggling
  // remounts a tile under a different parent, and its mount-time entrance
  // (fade up from blur, scale 0.95, plus a cascade delay of up to ~2.5s)
  // would fire again right on top of the morph — the image would blink out
  // and fade back rather than simply growing. They opt out permanently.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());

  // Tiles currently morphing. They're lifted out of the wall's stacking
  // order for the duration — a tile growing out of column 1 would otherwise
  // pass behind columns 2 and 3, which paint later. Cleared per tile when
  // its own layout animation reports done.
  const [flying, setFlying] = useState<ReadonlySet<string>>(new Set());
  const settle = (id: string) =>
    setFlying((current) => {
      if (!current.has(id)) return current;
      const updated = new Set(current);
      updated.delete(id);
      return updated;
    });

  const toggleExpanded = (id: string) => {
    const next = expandedId === id ? null : id;
    // Swapping between two expanded tiles sends both flying at once.
    setFlying(new Set(expandedId && expandedId !== id ? [id, expandedId] : [id]));
    setToggled((current) => {
      const updated = new Set(current);
      updated.add(id);
      // Swapping straight from one expanded tile to another remounts both.
      if (expandedId) updated.add(expandedId);
      return updated;
    });
    setExpandedId(next);
    // The hero lands at the top of the wall, which is off-screen if the tile
    // was clicked further down. Jump the scroller first so the morph plays
    // where the eye already is, instead of animating into empty space.
    if (next) scrollRef.current?.scrollTo({ top: 0 });
  };

  return (
    <aside
      style={{ width, minWidth: width, maxWidth: width, flexBasis: width }}
      className={cx("flex h-full shrink-0 flex-col gap-2.5 overflow-hidden pt-2", className)}
    >
      {/* Tab switcher + panel actions — identical rhythm to the code panel */}
      <div className="flex h-[30px] w-full items-center justify-between">
        <PillTabList aria-label="Panel view">
          <PillTab
            icon={RiGalleryLine}
            // Optical correction, not a size change: RiGalleryLine is a dense
            // filled rectangle, so at the shared 20px box it reads bigger than
            // the sparkle beside it. 18px makes the pair look equal.
            className="[&_svg]:size-[18px]"
            isSelected={tab === "gallery"}
            onSelect={() => setTab("gallery")}
          >
            Gallery
          </PillTab>
          <PillTab icon={RiSparkling2Line} isSelected={tab === "styles"} onSelect={() => setTab("styles")}>
            Styles
          </PillTab>
        </PillTabList>
        <div className="flex items-center gap-2 pr-px">
          <PanelAction icon={RiImageAddLine} label="New generation" />
          <PanelAction icon={RiExpandDiagonalSLine} label="Expand panel" />
          <PanelAction icon={RiSideBarLine} label="Toggle panel" />
        </div>
      </div>

      {tab === "gallery" ? (
        // The grid owns the full panel below the header — no count label or
        // padding stealing space, so tiles run edge to edge and the column
        // flow fills the height.
        <div
          ref={scrollRef}
          className="min-h-0 w-full flex-1 overflow-y-auto [scrollbar-width:thin]"
        >
          <div className="flex flex-col gap-2">
            {/* Expanded tile: a full-width row above the wall. No
                AnimatePresence — a shared `layoutId` needs exactly one
                element on screen at a time, and an exiting copy would leave
                two, which cancels the morph. */}
            {expanded && (
              <GenerationTile
                key={expanded.id}
                generation={expanded}
                isExpanded
                skipEntrance
                isFlying={flying.has(expanded.id)}
                onToggle={() => toggleExpanded(expanded.id)}
                onSettled={() => settle(expanded.id)}
              />
            )}

            {/* Explicit balanced columns (not CSS `columns-3`): masonry flow
                with insertion that only disturbs one column, which is what
                lets motion animate the shift. 8px gutter in both axes. */}
            <div className="flex gap-2">
              {visibleColumns.map((column, index) => (
                <div key={index} className="flex min-w-0 flex-1 flex-col gap-2">
                  {column.map((generation) => (
                    <GenerationTile
                      key={generation.id}
                      generation={generation}
                      isNew={generatedIds.has(generation.id)}
                      order={generation.order}
                      skipEntrance={toggled.has(generation.id)}
                      isFlying={flying.has(generation.id)}
                      onToggle={() => toggleExpanded(generation.id)}
                      onSettled={() => settle(generation.id)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex w-full flex-1 items-center justify-center rounded-2lg bg-background-secondary-default">
          <span className="text-body-medium text-text-tertiary">Style presets</span>
        </div>
      )}
    </aside>
  );
}
