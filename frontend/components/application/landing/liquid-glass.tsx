"use client";

import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  rgba,
  useGlassConfig,
  type GlassConfig,
} from "@/components/application/landing/liquid-glass-config";
import { cx } from "@/utils/cx";

/**
 * The Apple Liquid Glass material, as a layer you drop into any positioned
 * box. Extracted from `liquid-glass-button.tsx` so the nav's search field can
 * wear the same material as the CTA rather than a second, slightly different
 * approximation of it.
 *
 * The point of the effect is refraction, not blur: the backdrop must bend
 * inward at the rim like the edge of a water droplet, magnify slightly, and
 * fringe into color where it bends hardest. That takes an SVG displacement
 * filter on the *backdrop*:
 *
 *   map   a data-URI SVG rebuilt at the host's own pixel size. Red encodes X
 *         displacement (255 at the left edge → 0 at the right), blue encodes
 *         Y — both push sampling toward the center, which is what magnifies.
 *         A blurred neutral-gray rounded rect covers the middle, so distortion
 *         lives in an edge band and fades to nothing at the center. `splay`
 *         sets the band's width, `depth` how softly it falls off.
 *   glass three feDisplacementMaps run the frosted backdrop through that map
 *         at slightly different scales; a color matrix keeps one channel of
 *         each and screen-blending reassembles them. The channels land a few
 *         pixels apart only where displacement is strong — a rainbow fringe at
 *         the rim (`dispersion`), imperceptible in the center.
 *
 * `backdrop-filter: url(#…)` is Chromium-only. The layer under it carries a
 * plain blur/saturate frost every engine understands, so Safari and Firefox
 * get a clean frosted shape and Chromium refracts the already-frosted
 * backdrop — the same pipeline order the real material uses.
 *
 * Every layer takes `rounded-[inherit]`, so the host's own radius decides the
 * shape; pass `radius="full"` for pills so the lens core stays a pill too.
 */

/**
 * Per-instance overrides. Anything omitted comes from the shared glass config,
 * which is what the tuning panel drives — so dragging a slider retunes every
 * glass surface at once, and a call site only opts out where it must.
 */
export type LiquidGlassSettings = Partial<GlassConfig>;

export interface LiquidGlassSurfaceProps extends LiquidGlassSettings {
  /**
   * Corner radius of the lens core, in px — match the host's own radius.
   * `"full"` tracks half the measured height, for pills.
   */
  radius?: number | "full";
  /**
   * Respond to hover on an ancestor marked `group`. The surface cannot detect
   * hover itself (it is `pointer-events-none`), so hosts opt in and the CSS
   * in globals.css does the swap. Named `interactive` rather than `hover*` to
   * stay clear of the config's own `hoverLift` distance.
   */
  interactive?: boolean;
  /**
   * Render the SVG displacement (refraction) layer. Disable inside scaled
   * frames: `backdrop-filter: url()` uses userSpaceOnUse coordinates that
   * Chromium mismatches under ancestor transforms, painting the square map
   * region over the rounded surface. Frost, tint, sheen, and rim remain.
   */
  refract?: boolean;
  className?: string;
}

/** Displacement map: edge-weighted channel gradients around a neutral core. */
function displacementMap(w: number, h: number, band: number, falloff: number, corner: number) {
  const inset = Math.min(band, h / 2 - 1);
  // The neutral core follows the host's corners, so the lens bends the
  // backdrop evenly around the rim instead of leaving the corners flat.
  const radius = Math.max(0, corner - inset);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<defs>` +
    `<linearGradient id="x" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="rgb(255,0,0)"/><stop offset="1" stop-color="rgb(0,0,0)"/>` +
    `</linearGradient>` +
    `<linearGradient id="y" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="rgb(0,0,255)"/><stop offset="1" stop-color="rgb(0,0,0)"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<rect width="${w}" height="${h}" fill="black"/>` +
    `<rect width="${w}" height="${h}" fill="url(#x)"/>` +
    `<rect width="${w}" height="${h}" fill="url(#y)" style="mix-blend-mode:screen"/>` +
    `<rect x="${inset}" y="${inset}" width="${w - inset * 2}" height="${h - inset * 2}" rx="${radius}" ` +
    `fill="rgb(128,0,128)" style="filter:blur(${falloff}px)"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function LiquidGlassSurface({
  radius = 10,
  interactive = false,
  refract = true,
  className,
  ...overrides
}: LiquidGlassSurfaceProps) {
  const shared = useGlassConfig();
  const config = { ...shared, ...overrides };
  const {
    frost,
    saturate,
    refraction,
    depth,
    splay,
    dispersion,
    tintColor,
    tintOpacity,
    sheenColor,
    sheenOpacity,
    sheenAngle,
    rimWidth,
    rimAngle,
    rimOpacity,
    rimHighlight,
    rimHighlightOpacity,
    rimShadow,
    rimShadowOpacity,
    rimBounce,
    rimBounceOpacity,
    hoverMs,
    hoverTintOpacity,
    hoverSheenOpacity,
    hoverRimOpacity,
  } = config;

  // useId's `:` delimiters are invalid inside url(#…) references.
  const filterId = `lg-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hostRef = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  // The map is in real pixels (filterUnits=userSpaceOnUse), so it has to
  // follow the rendered size — a stretched map would warp the wrong places.
  // This layer is `inset-0`, so measuring itself measures the host.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const next = { w: Math.round(rect.width), h: Math.round(rect.height) };
      setBox((current) => (current.w === next.w && current.h === next.h ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const { w, h } = box;
  const corner = radius === "full" ? h / 2 : radius;
  const mapUri = useMemo(() => {
    if (!w || !h) return null;
    return displacementMap(w, h, 4 + 8 * splay, Math.max(1, 7 * depth), corner);
  }, [w, h, splay, depth, corner]);

  const scale = 56 * refraction;
  // Per-channel scale offset — the fringe is the gap between these.
  const spread = scale * 0.16 * dispersion;

  return (
    <span
      ref={hostRef}
      aria-hidden
      className={cx("pointer-events-none absolute inset-0", className)}
      style={
        {
          // Resting and hover values both land as variables; the `.lg-*`
          // classes in globals.css pick the right one under `.group:hover`
          // and transition between them. Doing it in CSS rather than React
          // state keeps hover off the render path entirely.
          "--lg-ms": `${hoverMs}ms`,
          "--lg-tint": rgba(tintColor, tintOpacity),
          "--lg-tint-hover": rgba(tintColor, hoverTintOpacity),
          "--lg-sheen": sheenOpacity,
          "--lg-sheen-hover": hoverSheenOpacity,
          // The rim lives in globals.css so it can use the two-layer mask, but
          // every colour and dimension in it comes from here.
          "--lg-rim-width": `${rimWidth}px`,
          "--lg-rim-angle": `${rimAngle}deg`,
          "--lg-rim-o": rimOpacity,
          "--lg-rim-o-hover": hoverRimOpacity,
          "--lg-rim-hi": rgba(rimHighlight, rimHighlightOpacity),
          "--lg-rim-sh": rgba(rimShadow, rimShadowOpacity),
          "--lg-rim-bounce": rgba(rimBounce, rimBounceOpacity),
          // The near-transparent stops between the features, derived so there
          // is one fewer knob doing nothing interesting.
          "--lg-rim-dim": rgba(rimHighlight, rimHighlightOpacity * 0.11),
        } as CSSProperties
      }
    >
      {refract && mapUri ? (
        <svg aria-hidden className="pointer-events-none absolute size-0">
          <filter
            id={filterId}
            x="0"
            y="0"
            width={w}
            height={h}
            filterUnits="userSpaceOnUse"
            colorInterpolationFilters="sRGB"
          >
            <feImage href={mapUri} x="0" y="0" width={w} height={h} result="map" />
            <feDisplacementMap
              in="SourceGraphic"
              in2="map"
              scale={scale + spread}
              xChannelSelector="R"
              yChannelSelector="B"
              result="dispR"
            />
            <feColorMatrix
              in="dispR"
              type="matrix"
              values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
              result="chanR"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="map"
              scale={scale}
              xChannelSelector="R"
              yChannelSelector="B"
              result="dispG"
            />
            <feColorMatrix
              in="dispG"
              type="matrix"
              values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
              result="chanG"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="map"
              scale={scale - spread}
              xChannelSelector="R"
              yChannelSelector="B"
              result="dispB"
            />
            <feColorMatrix
              in="dispB"
              type="matrix"
              values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
              result="chanB"
            />
            <feBlend in="chanR" in2="chanG" mode="screen" result="chanRG" />
            <feBlend in="chanRG" in2="chanB" mode="screen" />
          </filter>
        </svg>
      ) : null}

      {/* Frost every engine renders — and the input Chromium refracts. */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-[inherit]"
        style={{
          backdropFilter: `blur(${frost}px) saturate(${saturate}%)`,
          WebkitBackdropFilter: `blur(${frost}px) saturate(${saturate}%)`,
        }}
      />
      {refract && mapUri ? (
        <span
          aria-hidden
          className="absolute inset-0 rounded-[inherit]"
          style={{ backdropFilter: `url(#${filterId})` }}
        />
      ) : null}

      {/* Material tint + directional sheen. `lg-hover` opts the layer into the
          hover variables; without it the resting value simply stays put. */}
      <span
        aria-hidden
        className={cx("lg-tint absolute inset-0 rounded-[inherit]", interactive && "lg-hover")}
      />
      <span
        aria-hidden
        className={cx("lg-sheen absolute inset-0 rounded-[inherit]", interactive && "lg-hover")}
        style={{
          background: `linear-gradient(${sheenAngle}deg, ${rgba(sheenColor, 1)} 0%, ${rgba(sheenColor, 0)} 30%, ${rgba(sheenColor, 0)} 68%, ${rgba(sheenColor, 0.32)} 100%)`,
        }}
      />

      {/* Static rim light — a bevel lit from above, not a travelling sheen. */}
      <span
        aria-hidden
        className={cx("landing-glass-stroke", interactive && "lg-hover")}
      />
    </span>
  );
}

/**
 * Neutralises a token-styled button so the glass behind it shows through.
 *
 * `Button`/`IconLinkButton` bring their own fill, border and shadow — all of
 * which would paint over the refracted backdrop and flatten it back into a
 * solid control. The hover/active variants have to be cleared too, or the
 * material blinks back to opaque on pointer-over.
 */
export const LIQUID_GLASS_RESET =
  "relative z-10 border-transparent bg-transparent shadow-none hover:border-transparent hover:bg-transparent active:border-transparent active:bg-transparent";

/**
 * A glass pill sized to whatever control it wraps. The child must carry
 * `LIQUID_GLASS_RESET` so it stops painting its own surface.
 */
/**
 * Chrome for the element that *hosts* a glass surface: the drop shadow, and
 * the lift/scale on hover. Split out because the search trigger is its own
 * `<button>` rather than a `LiquidGlassChip`, and both need to move the same
 * way when hovered.
 */
export function useLiquidGlassHost(overrides?: LiquidGlassSettings) {
  const shared = useGlassConfig();
  const config = { ...shared, ...overrides };

  return {
    className: "lg-host group relative",
    style: {
      "--lg-ms": `${config.hoverMs}ms`,
      "--lg-shadow": `0 ${config.shadowY}px ${config.shadowBlur}px ${rgba(config.shadowColor, config.shadowOpacity)}`,
      "--lg-shadow-hover": `0 ${config.hoverShadowY}px ${config.hoverShadowBlur}px ${rgba(config.shadowColor, config.hoverShadowOpacity)}`,
      "--lg-lift": `${config.hoverLift}px`,
      "--lg-scale": config.hoverScale,
    } as CSSProperties,
  };
}

export function LiquidGlassChip({
  children,
  className,
  radius = 10,
  ...settings
}: LiquidGlassSettings & {
  children: ReactNode;
  className?: string;
  radius?: number | "full";
}) {
  const host = useLiquidGlassHost(settings);

  return (
    <span className={cx(host.className, "inline-flex rounded-2lg", className)} style={host.style}>
      <LiquidGlassSurface radius={radius} interactive className="rounded-[inherit]" {...settings} />
      {children}
    </span>
  );
}
