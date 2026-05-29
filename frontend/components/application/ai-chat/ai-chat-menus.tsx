"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowDropDownLine,
  RiAttachment2,
  RiFocus3Line,
  RiFolder2Line,
  RiListCheck3,
} from "@remixicon/react";
import { AnimatePresence, motion } from "motion/react";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
  Slider as AriaSlider,
  SliderThumb as AriaSliderThumb,
  SliderTrack as AriaSliderTrack,
} from "react-aria-components";
import { RadioDot } from "@/components/base/radio/radio";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → "ai_chat" dropdowns (nodes 4035:6313 and
 * 4035:6925).
 *
 * The two popover menus of the chat template, built on the same
 * react-aria popover recipe as the dashboard team menu (266px white panel,
 * radius 16, p 10, shadow/dropdown, scale + blur entry animation):
 *
 * - ProjectFolderMenu — "Local Folders" picker opened from the status bar's
 *   project item. Rows show the folder path (secondary) + name (primary).
 * - ModelMenu — model picker opened from the composer's model button.
 *   "Models" radio group on top, and below a divider the "Effort" section
 *   with a draggable 6-stop slider (Faster ↔ Smarter).
 * - AddMenu — the composer's plus button (Figma node 4040:5414). A wider
 *   361px panel with tighter p-8 padding: an "Add" group of remixicon rows
 *   and a "Plugins" group of rows with 24px illustrated document icons.
 */

/*
 * Every composer menu is non-modal. React Aria's popovers lock page scroll by
 * default, and removing the scrollbar reflows the page under them: on the docs
 * pages that shunted the sticky component sidebar upwards the moment a menu
 * opened. These are menus hanging off a control, not modals, so nothing about
 * them should freeze the page behind.
 */
const POPOVER_CLASSES = cx(
  "w-[266px] max-w-[calc(100vw-32px)] origin-bottom-left",
  "rounded-2xl border border-border-button-default bg-background-primary-default p-2.5 shadow-dropdown",
  "transition duration-150 ease-out",
  "data-[entering]:opacity-0 data-[entering]:scale-95 data-[entering]:blur-[2px]",
  "data-[exiting]:opacity-0 data-[exiting]:scale-95 data-[exiting]:blur-[2px]",
);

/* ---------------------------------------------------------- project folders */

interface LocalFolder {
  /** Muted path prefix, e.g. "users/mertcan/". */
  prefix: string;
  name: string;
}

const LOCAL_FOLDERS: LocalFolder[] = [
  { prefix: "users/mertcan/", name: "project-sea" },
  { prefix: "users/desktop/", name: "vibl" },
  { prefix: "users/documents/", name: "boardui" },
];

/** Status-bar trigger + "Local Folders" popover (Figma node 4035:6313). */
export function ProjectFolderMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState(LOCAL_FOLDERS[0]);

  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={setIsOpen}>
      <AriaButton className="flex cursor-pointer items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring">
        <RiFolder2Line className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
        <span className="flex items-center">
          <span className="text-body-2-medium whitespace-nowrap text-text-secondary">
            {selected.name}
          </span>
          <RiArrowDropDownLine
            className={cx(
              "size-4 shrink-0 text-foreground-icon-secondary transition-transform duration-200 ease",
              isOpen && "rotate-180",
            )}
            aria-hidden
          />
        </span>
      </AriaButton>

      <AriaPopover isNonModal placement="top start" offset={8} className={POPOVER_CLASSES}>
        <AriaDialog aria-label="Local folders" className="outline-none">
          <div className="flex w-full flex-col gap-1.5 pt-1">
            <span className="pl-2 text-body-medium text-text-secondary">Local Folders</span>
            <div className="flex w-full flex-col gap-1">
              {LOCAL_FOLDERS.map((folder) => (
                <button
                  key={folder.name}
                  type="button"
                  aria-pressed={folder.name === selected.name}
                  onClick={() => {
                    setSelected(folder);
                    setIsOpen(false);
                  }}
                  className={cx(
                    "flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 outline-none transition-colors",
                    folder.name === selected.name
                      ? "bg-background-primary-hover"
                      : "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
                  )}
                >
                  <RiFolder2Line
                    className="size-5 shrink-0 text-foreground-icon-secondary"
                    aria-hidden
                  />
                  <span className="truncate text-body-medium whitespace-nowrap">
                    <span className="text-text-secondary">{folder.prefix}</span>
                    <span className="text-text-primary">{folder.name}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}

/* ------------------------------------------------------------- model picker */

const MODELS = ["Composer 2.5", "GPT-5.6 Sol", "Fable 5", "Sonnet 5"];

/** Six effort stops between "Faster" and "Smarter"; index 1 ("Medium") is the
 *  Figma default. */
const EFFORT_LEVELS = ["Low", "Medium", "Balanced", "High", "Very High", "Max"];

/**
 * Shader-style "pixelation" overlay shown when the slider hits max: a canvas
 * over the track where a dense field of blue pixels burns at the right edge
 * and dissolves out toward the left — cell density and opacity both fall off
 * with distance from the right. Runs at ~12fps and cleans up on unmount.
 */
function PixelationOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const cell = 3;
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    // Blue noise palette (blue-300 → blue-600)
    const palette = [
      [142, 197, 255], // blue-300
      [81, 162, 255], // blue-400
      [43, 127, 255], // blue-500
      [21, 93, 252], // blue-600
    ];

    let raf = 0;
    let last = 0;
    const draw = (time: number) => {
      if (time - last > 70) {
        last = time;
        ctx.clearRect(0, 0, width, height);
        for (let col = 0; col < cols; col++) {
          // 0 at the left edge → 1 at the right edge: dense at the right,
          // dissolving out toward the left. Capped below 1 so even the
          // rightmost cells keep flickering instead of reading as solid.
          const t = col / (cols - 1);
          const density = 0.78 * Math.pow(t, 1.6);
          for (let row = 0; row < rows; row++) {
            if (Math.random() < density) {
              const [r, g, b] = palette[(Math.random() * palette.length) | 0];
              // Fully random alpha per cell per frame keeps the field alive
              const alpha = (0.15 + Math.random() * 0.85) * (0.35 + 0.65 * t);
              ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
              ctx.fillRect(col * cell, row * cell, cell - 1, cell - 1);
            }
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <motion.div
      aria-hidden
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="pointer-events-none absolute inset-0"
    >
      {/* blue-300 wash bleeding in from the right, under the pixel noise */}
      <div className="absolute inset-0 bg-gradient-to-l from-blue-300/90 via-blue-300/30 to-transparent" />
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
    </motion.div>
  );
}

/* -------------------------------------------------- max-effort flame shader */

const FLAME_VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/**
 * Procedural blue rocket-exhaust plume: fbm turbulence advected right-to-left,
 * with a white-hot core at the nozzle (right edge) cooling through blue-300 →
 * blue-600 as it dissolves toward the left, plus a soft ambient glow.
 */
const FLAME_FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_power; // 0 -> 1 throttle-up after ignition

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.1 + vec2(37.4, 17.9);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float d = 1.0 - uv.x;            // 0 at the nozzle (right) -> 1 far left
  float y = (uv.y - 0.5) * 2.0;    // -1 bottom .. 1 top

  // Turbulence blown leftward; second octave wobbles the plume axis
  float turb = fbm(vec2(uv.x * 5.5 + u_time * 3.2, uv.y * 3.5 + u_time * 0.4)) - 0.5;
  float sway = (fbm(vec2(u_time * 1.6, uv.x * 2.0)) - 0.5) * 0.55;

  // Plume envelope: wide at the nozzle, tapering left, edges licked by noise.
  // Throttle (u_power) grows the plume from a short narrow jet to full burn.
  float width = mix(1.05, 0.12, smoothstep(0.0, 1.0, d)) * mix(0.35, 1.0, u_power);
  float reach = mix(0.18, 1.05, u_power);
  float shape = 1.0 - smoothstep(width * 0.35, width, abs(y + sway * d + turb * (0.35 + d * 0.9)));
  float len = 1.0 - smoothstep(0.15 * u_power, reach, d + turb * 0.45 * u_power);
  float flame = clamp(shape * len, 0.0, 1.0);

  // Extra hot core hugging the nozzle centre line
  float core = (1.0 - smoothstep(0.0, 0.38 * mix(0.5, 1.0, u_power), d + turb * 0.15)) * (1.0 - smoothstep(0.0, 0.55, abs(y)));
  flame = clamp(flame + core * 0.6, 0.0, 1.0) * mix(0.6, 1.0, u_power);

  // Ambient glow so the flame feels emissive even past its tongues
  float glow = (1.0 - smoothstep(0.0, 0.85, d)) * (1.0 - smoothstep(0.2, 1.15, abs(y))) * 0.4 * u_power;

  // blue-600 -> blue-400 -> blue-200 -> white-hot. The white core is gated on
  // nozzle distance too, so only the plume root burns white and the body
  // stays saturated blue.
  vec3 c600 = vec3(0.082, 0.365, 0.988);
  vec3 c400 = vec3(0.318, 0.635, 1.0);
  vec3 c200 = vec3(0.741, 0.867, 1.0);
  vec3 col = mix(c600, c400, smoothstep(0.2, 0.6, flame));
  col = mix(col, c200, smoothstep(0.62, 0.95, flame) * (1.0 - smoothstep(0.1, 0.75, d)));
  float hot = smoothstep(0.9, 1.0, flame) * (1.0 - smoothstep(0.02, 0.3, d));
  col = mix(col, vec3(1.0), hot);

  float alpha = smoothstep(0.04, 0.55, flame) * 0.96 + glow;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

/**
 * Parallax starfield behind the flame: three depth layers of tiny stars
 * streaming right-to-left at different speeds (near = faster + brighter +
 * stretched into streaks), plus the occasional fast shooting star — the
 * ship is moving, the stars fly past.
 */
function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    interface Star {
      x: number;
      y: number;
      speed: number; // px/s leftward
      size: number;
      alpha: number;
    }

    // depth: 0 far … 1 near — near stars are faster, larger, brighter
    const makeStar = (spawnAnywhere: boolean): Star => {
      const depth = Math.random();
      return {
        x: spawnAnywhere ? Math.random() * width : width + 4,
        y: 1 + Math.random() * (height - 2),
        speed: 18 + depth * 90,
        size: 0.6 + depth * 1.0,
        alpha: 0.4 + depth * 0.55,
      };
    };
    const stars: Star[] = Array.from({ length: 40 }, () => makeStar(true));

    let shooting: (Star & { life: number }) | null = null;

    let raf = 0;
    let last = performance.now();
    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      ctx.clearRect(0, 0, width, height);

      for (const star of stars) {
        star.x -= star.speed * dt;
        if (star.x < -6) Object.assign(star, makeStar(false));
        // motion streak: length scales with speed so near stars smear
        const streak = star.speed * 0.05;
        const grad = ctx.createLinearGradient(star.x, star.y, star.x + streak, star.y);
        grad.addColorStop(0, `rgba(255,255,255,${star.alpha.toFixed(3)})`);
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(star.x, star.y - star.size / 2, streak + star.size, star.size);
      }

      // ~ every 2.5s launch a shooting star: long bright streak, fades out
      if (!shooting && Math.random() < dt / 2.5) {
        shooting = { ...makeStar(false), speed: 260 + Math.random() * 120, size: 1.2, alpha: 0.9, life: 1 };
      }
      if (shooting) {
        shooting.x -= shooting.speed * dt;
        shooting.life -= dt * 0.9;
        if (shooting.x < -40 || shooting.life <= 0) {
          shooting = null;
        } else {
          const len = 26;
          const a = shooting.alpha * Math.max(shooting.life, 0);
          const grad = ctx.createLinearGradient(shooting.x, shooting.y, shooting.x + len, shooting.y);
          grad.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
          grad.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = grad;
          ctx.fillRect(shooting.x, shooting.y - 0.6, len, 1.2);
        }
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 size-full" />;
}

/**
 * WebGL flame overlay shown when the slider hits max: a blue rocket-engine
 * exhaust plume firing right-to-left across the track (see FLAME_FRAG),
 * over a parallax starfield streaming past. Falls back to the pixel-noise
 * overlay if a WebGL context can't be created.
 */
function FlameOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
    if (!gl) {
      setWebglFailed(true);
      return;
    }

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, FLAME_VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FLAME_FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setWebglFailed(true);
      return;
    }
    gl.useProgram(program);

    // Full-screen triangle strip quad
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(gl.getUniformLocation(program, "u_res"), canvas.width, canvas.height);
    const uTime = gl.getUniformLocation(program, "u_time");
    const uPower = gl.getUniformLocation(program, "u_power");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let raf = 0;
    const start = performance.now();
    const draw = (now: number) => {
      const elapsed = (now - start) / 1000;
      gl.uniform1f(uTime, elapsed);
      // Throttle up over ~1.4s with an ease-out so the burn builds gradually
      const t = Math.min(elapsed / 1.4, 1);
      gl.uniform1f(uPower, 1 - Math.pow(1 - t, 3));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    // No loseContext() here: React strict-mode re-runs the effect on the same
    // canvas, and a deliberately-lost context would poison the second run.
    // The context is reclaimed with the canvas when the overlay unmounts.
    return () => cancelAnimationFrame(raf);
  }, []);

  if (webglFailed) return <PixelationOverlay />;

  return (
    <motion.div
      aria-hidden
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="pointer-events-none absolute inset-0"
    >
      {/* faint dark space wash so the white stars read on the grey track */}
      <div className="absolute inset-0 rounded-lg bg-[rgba(16,24,40,0.62)]" />
      <Starfield />
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
    </motion.div>
  );
}

/**
 * Which effect plays when effort hits Max. Flip to "pixelation" to bring the
 * blue pixel-noise burn back.
 */
const MAX_EFFORT_EFFECT: "flame" | "pixelation" = "flame";

/**
 * Effort slider (Figma node 4037:4885): 27px-tall neutral track with six
 * 3×13 tick marks, a light-grey fill up to the 21×27 bordered thumb. Built on
 * react-aria's Slider for drag + keyboard support.
 *
 * The thumb travels edge to edge: at min it sits flush with the track's left
 * edge, at max flush with the right. Thumb centers move from 10.5px to
 * (width − 10.5)px, so on the 230px track the six stops are 41.8px apart and
 * the ticks are laid out to match. At max, a pixel-noise overlay flickers
 * across the track.
 */
function EffortSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const isMax = value === EFFORT_LEVELS.length - 1;
  // Fresh random impulse per tick each time the engine ignites: blown left by
  // the exhaust with random lift, tumble and stagger, like debris in the blast.
  const blast = useMemo(
    () =>
      EFFORT_LEVELS.map(() => ({
        x: -(70 + Math.random() * 130),
        y: (Math.random() - 0.5) * 70,
        rotate: (Math.random() - 0.5) * 720,
        delay: Math.random() * 0.3,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isMax],
  );
  // Thumb center sits at `fraction` of the 21px-inset rail, so its right edge
  // is at fraction × (track − 21px) + 21px — expressed here in calc() so the
  // fill lands flush against the thumb at any rendered track width.
  const fraction = value / (EFFORT_LEVELS.length - 1);
  return (
    <AriaSlider
      aria-label="Effort"
      minValue={0}
      maxValue={EFFORT_LEVELS.length - 1}
      step={1}
      value={value}
      onChange={(v) => onChange(v as number)}
      className="w-full"
    >
      <div className="relative h-[27px] w-full overflow-hidden rounded-lg bg-background-secondary-default">
        {/* Fill up to the thumb's right edge */}
        <div
          className="absolute inset-y-0 left-0 rounded-lg bg-background-tertiary-hover transition-[width] duration-150 ease-out"
          style={{ width: `calc(${fraction} * (100% - 21px) + 21px)` }}
        />
        {/* Tick marks on the thumb stops — stops past the current value fade
            to 30%. Insets keep tick centers on the thumb centers (10.5px +
            i × stop, ticks are 3px wide). */}
        <div className="absolute inset-x-[9px] top-[7px] flex h-[13px] items-center justify-between">
          {EFFORT_LEVELS.map((level, index) => (
            <motion.span
              key={level}
              animate={
                isMax
                  ? {
                      x: blast[index].x,
                      y: blast[index].y,
                      rotate: blast[index].rotate,
                      opacity: 0,
                    }
                  : { x: 0, y: 0, rotate: 0, opacity: index > value ? 0.3 : 1 }
              }
              transition={
                isMax
                  ? { duration: 1.6, ease: [0.22, 0.5, 0.5, 1], delay: blast[index].delay }
                  : { duration: 0.3, ease: "easeOut" }
              }
              className="h-full w-[3px] rounded-[2px] bg-foreground-icon-tertiary"
            />
          ))}
        </div>
        {/* Above the ticks so the effect washes over the step dividers */}
        <AnimatePresence>
          {isMax &&
            (MAX_EFFORT_EFFECT === "flame" ? <FlameOverlay /> : <PixelationOverlay />)}
        </AnimatePresence>
        {/* Rail inset by half the thumb width so the 21px thumb lands flush
            on both track edges. The wrapper div does the absolute positioning
            because SliderTrack forces `position: relative` inline. */}
        <div className="absolute inset-x-[10.5px] inset-y-0">
          <AriaSliderTrack className="h-full w-full">
            <AriaSliderThumb className="top-1/2 h-[27px] w-[21px] cursor-grab rounded-[7px] border border-border-checkbox-default bg-background-primary-default shadow-xs outline-none transition-shadow data-[dragging]:cursor-grabbing data-[focus-visible]:ring-2 data-[focus-visible]:ring-border-focus-ring" />
          </AriaSliderTrack>
        </div>
      </div>
    </AriaSlider>
  );
}

/**
 * The Models + Effort panel itself, extracted from the popover so other
 * surfaces (the landing collage) can render the exact same component as a
 * standalone card. Controlled: the caller owns model and effort state.
 */
export function ModelSettingsPanel({
  model,
  onModelChange,
  effort,
  onEffortChange,
}: {
  model: string;
  onModelChange: (model: string) => void;
  effort: number;
  onEffortChange: (effort: number) => void;
}) {
  return (
    <div className="flex flex-col">
      {/* Models */}
      <div className="flex w-full flex-col gap-1.5 pt-1">
        <span className="pl-2 text-body-medium text-text-secondary">Models</span>
        <div className="flex w-full flex-col gap-1" role="radiogroup" aria-label="Model">
          {MODELS.map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={name === model}
              onClick={() => onModelChange(name)}
              className={cx(
                "flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-2lg p-2 outline-none transition-colors",
                name === model
                  ? "bg-background-primary-hover"
                  : "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
              )}
            >
              <span className="truncate text-body-medium whitespace-nowrap text-text-primary">
                {name}
              </span>
              <RadioDot selected={name === model} />
            </button>
          ))}
        </div>
      </div>

      {/* Divider (full bleed, like the team menu) */}
      <div className="-mx-2.5 mt-[7px] mb-3 h-px bg-border-button-default" />

      {/* Effort */}
      <div className="flex w-full flex-col">
        <span className="pl-2 text-body-medium text-text-secondary">
          Effort{" "}
          {/* Keyed on the value so each change remounts and blurs in */}
          <motion.span
            key={EFFORT_LEVELS[effort]}
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="inline-block text-text-primary"
          >
            {EFFORT_LEVELS[effort]}
          </motion.span>
        </span>
        <div className="flex w-full flex-col gap-1">
          <div className="flex w-full items-center justify-between px-2 pt-2 pb-[3px]">
            <span className="text-body-2-medium whitespace-nowrap text-text-secondary">
              Faster
            </span>
            <span className="text-body-2-medium whitespace-nowrap text-text-secondary">
              Smarter
            </span>
          </div>
          <div className="w-full px-2 pb-2">
            <EffortSlider value={effort} onChange={onEffortChange} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Composer trigger + "Models / Effort" popover (Figma node 4035:6925). */
export function ModelMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const [model, setModel] = useState("Fable 5");
  const [effort, setEffort] = useState(1);

  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={setIsOpen}>
      <AriaButton className="flex h-8 shrink-0 cursor-pointer items-center justify-center gap-0.5 rounded-xl bg-background-primary-default py-1.5 pr-1 pl-2 outline-none transition-colors duration-150 ease hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring">
        <span className="px-0.5 text-body-medium whitespace-nowrap text-text-secondary">
          {model}
        </span>
        <RiArrowDownSLine
          className={cx(
            "size-[18px] shrink-0 text-foreground-icon-secondary transition-transform duration-200 ease",
            isOpen && "rotate-180",
          )}
          aria-hidden
        />
      </AriaButton>

      <AriaPopover isNonModal placement="top start" offset={8} className={POPOVER_CLASSES}>
        <AriaDialog aria-label="Model settings" className="flex flex-col outline-none">
          <ModelSettingsPanel
            model={model}
            // Picking a model is the decision the menu exists for, so it
            // dismisses itself. Effort is a dial you may want to nudge more
            // than once, so it deliberately leaves the menu open.
            onModelChange={(next) => {
              setModel(next);
              setIsOpen(false);
            }}
            effort={effort}
            onEffortChange={setEffort}
          />
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}

/* ----------------------------------------------------------------- add menu */

interface AddMenuRow {
  label: string;
  /** Muted inline description after the label. */
  description?: string;
  /** 20px remixicon rows ("Add" group). */
  icon?: typeof RiAttachment2;
  /** 24px illustrated icon rows ("Plugins" group). */
  image?: string;
  /** Optional manual-dark-theme variant of the illustrated icon. */
  darkImage?: string;
}

const ADD_ROWS: AddMenuRow[] = [
  { icon: RiAttachment2, label: "Files and folders" },
  { icon: RiFocus3Line, label: "Goal", description: "Set a goal for faster results" },
  { icon: RiListCheck3, label: "Plan mode", description: "Manage complex tasks" },
];

const PLUGIN_ROWS: AddMenuRow[] = [
  {
    image: "/ai-chat/plugin-documents.svg",
    darkImage: "/ai-chat/plugin-documents-dark.svg",
    label: "Documents",
    description: "Create and edit documents",
  },
  { image: "/ai-chat/plugin-spreadsheets.svg", label: "Spreadsheets", description: "Generate spreadsheets" },
  { image: "/ai-chat/plugin-presentations.svg", label: "Presentations", description: "Create marketing assets" },
  { image: "/ai-chat/plugin-codeblocks.svg", label: "Code blocks", description: "Write and edit existing code" },
];

function AddMenuItem({ icon: Icon, image, darkImage, label, description, onSelect }: AddMenuRow & { onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full cursor-pointer items-center gap-2 rounded-2lg px-2 py-1.5 outline-none transition-colors hover:bg-background-primary-hover focus-visible:bg-background-primary-hover"
    >
      {Icon && <Icon className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />}
      {image && (
        <>
          <Image
            src={image}
            alt=""
            width={24}
            height={24}
            unoptimized
            className={cx("size-6 shrink-0", darkImage && "theme-asset-light")}
            aria-hidden
          />
          {darkImage && (
            <Image
              src={darkImage}
              alt=""
              width={24}
              height={24}
              unoptimized
              className="theme-asset-dark size-6 shrink-0"
              aria-hidden
            />
          )}
        </>
      )}
      <span className="truncate text-body-medium whitespace-nowrap">
        <span className="text-text-primary">{label}</span>
        {description && <span className="ml-1.5 text-text-secondary">{description}</span>}
      </span>
    </button>
  );
}

function AddMenuGroup({
  label,
  rows,
  onSelect,
}: {
  label: string;
  rows: AddMenuRow[];
  onSelect: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-1.5 pt-1">
      <span className="pl-2 text-body-medium text-text-secondary">{label}</span>
      <div className="flex w-full flex-col gap-1">
        {rows.map((row) => (
          <AddMenuItem key={row.label} {...row} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

/**
 * Composer plus-button + "Add / Plugins" popover (Figma node 4040:5414).
 * A custom, more detailed dropdown than the other menus: wider (361px),
 * tighter 8px panel padding, and rows with inline muted descriptions —
 * the "Plugins" group uses the illustrated 24px document icons exported
 * from Figma (public/ai-chat/plugin-*.svg).
 */
export function AddMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const close = () => setIsOpen(false);

  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={setIsOpen}>
      <AriaButton
        aria-label="Add attachment"
        className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ai-chat-composer-add-background p-2 outline-none transition-colors duration-150 ease hover:bg-ai-chat-composer-add-hover-background focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiAddLine
          className={cx(
            "size-5 text-foreground-icon-primary transition-transform duration-200 ease",
            isOpen && "rotate-45",
          )}
          aria-hidden
        />
      </AriaButton>

      <AriaPopover
        isNonModal
        placement="top start"
        offset={8}
        className={cx(
          "w-[361px] max-w-[calc(100vw-32px)] origin-bottom-left",
          "rounded-2xl border border-border-button-default bg-background-primary-default p-2 shadow-dropdown",
          "transition duration-150 ease-out",
          "data-[entering]:opacity-0 data-[entering]:scale-95 data-[entering]:blur-[2px]",
          "data-[exiting]:opacity-0 data-[exiting]:scale-95 data-[exiting]:blur-[2px]",
        )}
      >
        <AriaDialog aria-label="Add to chat" className="flex flex-col gap-2 outline-none">
          <AddMenuGroup label="Add" rows={ADD_ROWS} onSelect={close} />
          <AddMenuGroup label="Plugins" rows={PLUGIN_ROWS} onSelect={close} />
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
