"use client";

import { useState } from "react";
import { ResponsiveContainer, Sankey } from "recharts";

/** Geometry recharts 2.x passes to a custom `node` renderer (no exported type). */
type SankeyNodeProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
};

/** Geometry recharts 2.x passes to a custom `link` renderer (no exported type). */
type SankeyLinkProps = {
  sourceX: number;
  targetX: number;
  sourceY: number;
  targetY: number;
  sourceControlX: number;
  targetControlX: number;
  linkWidth: number;
  index: number;
};
import {
  ChartCard,
  ChartHeader,
  describeDelta,
  resolveTone,
  useChartRange,
  type ChartRange,
  type ChartTone,
} from "@/components/application/charts/chart-card";
import { cx } from "@/utils/cx";

/**
 * Sankey flow card on Recharts `Sankey`. Recharts lays out the nodes and
 * links; the card supplies the drawing: pill nodes coloured per node, links
 * tinted with their source's colour (so every ribbon leaving "Focus" is the
 * Focus green and the sinks read as a mix of where their time came from -
 * `linkColor="target"` flips that), source labels (name over value) on the
 * left and sink labels ("Browsing · 29%") on the right.
 *
 * `nodes` is a `{ name, color? }` list and `links` is `{ source, target,
 * value }` where source/target may be node names or indexes - add a node
 * and a link and the flow rebalances. Hovering a node lifts its links (and
 * fades the rest); hovering a link isolates it. Both swap the headline to
 * the hovered value.
 */

export type SankeyNodeDatum = {
  name: string;
  /** Any CSS colour; defaults to the chart palette by node index. Pass
   *  `"neutral"` for the grey used by minor sinks. */
  color?: string;
  activeColor?: string;
};

export type SankeyLinkDatum = {
  source: string | number;
  target: string | number;
  value: number;
};

/** A selectable period: pill label + the props it overrides. */
export type SankeyRange = ChartRange<{
  nodes: SankeyNodeDatum[];
  links: SankeyLinkDatum[];
  delta: number;
  headline: number;
}>;

export interface SankeyChartCardProps {
  /** Header label; swaps to the hovered node / link while hovering. */
  title?: string;
  nodes?: SankeyNodeDatum[];
  links?: SankeyLinkDatum[];
  /** Headline number at rest; defaults to the total flowing out of the
   *  source nodes. */
  headline?: number;
  /** Delta ratio for the chip, e.g. `0.052` → "+5.2%". */
  delta?: number;
  /** Static period pill ("This week"). Ignored when `ranges` is set. */
  range?: string;
  /** Selectable periods - the pill becomes a dropdown and the selected
   *  range's fields override the top-level props. */
  ranges?: SankeyRange[];
  /** Initially selected range id (defaults to the first). */
  defaultRange?: string;
  onRangeChange?: (id: string) => void;
  format?: (n: number) => string;
  /** Small captions under the left and right columns. */
  axisLabels?: [string, string];
  /** Which end's colour a ribbon takes. `source` (default) makes every flow
   *  out of a node share that node's colour. */
  linkColor?: "source" | "target";
  className?: string;
}

/** Ink for uncoloured (sink) nodes: a solid mid grey on light (neutral-400)
 *  and a soft off-white on dark (neutral-300), so the end caps read as firm anchors
 *  against the tinted ribbons in both modes; one step stronger on hover.
 *  `light-dark()` follows the `color-scheme` globals.css sets. Neutral
 *  ribbons, if any, get a higher opacity to compensate. */
const NEUTRAL: ChartTone = {
  color: "light-dark(var(--color-neutral-400), var(--color-neutral-300))",
  activeColor: "light-dark(var(--color-neutral-500), var(--color-neutral-100))",
};

const DEFAULT_NODES: SankeyNodeDatum[] = [
  // Sources carry the colour; sinks stay neutral so the ribbons paint them.
  { name: "Focus", color: "var(--color-chart-7)", activeColor: "var(--color-chart-7-active)" },
  { name: "Meetings", color: "var(--color-chart-5)", activeColor: "var(--color-chart-5-active)" },
  { name: "Breaks", color: "var(--color-chart-8)", activeColor: "var(--color-chart-8-active)" },
  { name: "Admin", color: "var(--color-chart-6)", activeColor: "var(--color-chart-6-active)" },
  { name: "Learning", color: "var(--color-chart-3)", activeColor: "var(--color-chart-3-active)" },
  { name: "Browsing", color: "neutral" },
  { name: "Writing", color: "neutral" },
  { name: "Messaging", color: "neutral" },
  { name: "Productivity", color: "neutral" },
  { name: "Email", color: "neutral" },
  { name: "Video calls", color: "neutral" },
  { name: "Everything else", color: "neutral" },
];

// Sources are deliberately balanced (32 / 18 / 12 / 14 / 10h) so every
// origin's node and ribbons stay thick, and each source fans out to sinks
// well above and below its own position so the ribbons sweep rather than
// run straight across.
const DEFAULT_LINKS: SankeyLinkDatum[] = [
  { source: "Focus", target: "Browsing", value: 10.4 },
  { source: "Focus", target: "Writing", value: 8.2 },
  { source: "Focus", target: "Messaging", value: 6.1 },
  { source: "Focus", target: "Productivity", value: 5.0 },
  { source: "Focus", target: "Email", value: 2.3 },
  { source: "Meetings", target: "Video calls", value: 9.6 },
  { source: "Meetings", target: "Everything else", value: 3.8 },
  { source: "Meetings", target: "Writing", value: 3.0 },
  { source: "Meetings", target: "Email", value: 1.6 },
  { source: "Breaks", target: "Everything else", value: 5.6 },
  { source: "Breaks", target: "Browsing", value: 3.6 },
  { source: "Breaks", target: "Video calls", value: 2.8 },
  { source: "Admin", target: "Productivity", value: 5.2 },
  { source: "Admin", target: "Writing", value: 4.0 },
  { source: "Admin", target: "Messaging", value: 3.2 },
  { source: "Admin", target: "Everything else", value: 1.6 },
  { source: "Learning", target: "Browsing", value: 4.6 },
  { source: "Learning", target: "Email", value: 3.4 },
  { source: "Learning", target: "Messaging", value: 2.0 },
];

const linksOf = (values: number[]): SankeyLinkDatum[] =>
  DEFAULT_LINKS.map((l, i) => ({ ...l, value: values[i] }));

/** Demo periods used when no nodes / links / range are given at all. */
const DEFAULT_RANGES: SankeyRange[] = [
  { id: "this-week", label: "This week", links: DEFAULT_LINKS },
  {
    id: "last-week",
    label: "Last week",
    links: linksOf([8.6, 9.4, 4.8, 6.2, 3.1, 7.2, 4.4, 2.6, 1.8, 5.1, 4.9, 2.2, 4.8, 3.6, 3.3, 2.5, 3.9, 4.6, 1.5]),
  },
  {
    id: "this-month",
    label: "This month",
    links: linksOf([44.8, 36.2, 24.5, 22.6, 9.9, 38.4, 14.2, 12.6, 7.4, 28.8, 15.7, 10.9, 27.2, 17.6, 12.1, 6.5, 19.4, 14.8, 8.3]),
  },
];

const defaultHours = (n: number) => `${Math.round(n * 10) / 10}h`;

/** Room reserved for the labels beside the two outer columns. */
const LABEL_LEFT = 88;
const LABEL_RIGHT = 150;

/**
 * Node outline rounded only on its outward side, so the link ribbons meet a
 * square edge and read as flush with the node instead of tucking under a
 * pill cap. Sources round on the left, sinks on the right, pass-through
 * nodes stay square.
 */
function nodePath(x: number, y: number, w: number, h: number, roundLeft: boolean, roundRight: boolean) {
  const r = Math.min(5, w, h / 2);
  const rl = roundLeft ? r : 0;
  const rr = roundRight ? r : 0;
  return [
    `M${x + rl},${y}`,
    `H${x + w - rr}`,
    rr ? `A${rr},${rr} 0 0 1 ${x + w},${y + rr}` : "",
    `V${y + h - rr}`,
    rr ? `A${rr},${rr} 0 0 1 ${x + w - rr},${y + h}` : "",
    `H${x + rl}`,
    rl ? `A${rl},${rl} 0 0 1 ${x},${y + h - rl}` : "",
    `V${y + rl}`,
    rl ? `A${rl},${rl} 0 0 1 ${x + rl},${y}` : "",
    "Z",
  ].join(" ");
}

export function SankeyChartCard({
  title = "Tracked time",
  nodes: nodesProp,
  links: linksProp,
  headline: headlineProp,
  delta: deltaProp,
  range,
  ranges,
  defaultRange,
  onRangeChange,
  format = defaultHours,
  axisLabels,
  linkColor = "source",
  className,
}: SankeyChartCardProps = {}) {
  const [active, setActive] = useState<{ type: "node" | "link"; index: number } | null>(null);

  // Built-in demo periods when the host supplies neither ranges nor data.
  const demo = ranges === undefined && range === undefined && nodesProp === undefined && linksProp === undefined;
  const rangeList = ranges ?? (demo ? DEFAULT_RANGES : undefined);
  const { selected, selectedId, select } = useChartRange(rangeList, defaultRange, onRangeChange);
  const selectRange = (id: string) => {
    setActive(null);
    select(id);
  };
  const nodes = selected?.nodes ?? nodesProp ?? DEFAULT_NODES;
  const links = selected?.links ?? linksProp ?? DEFAULT_LINKS;
  const headline = selected?.headline ?? headlineProp;
  const delta = selected?.delta ?? deltaProp;

  const indexOf = (ref: string | number) =>
    typeof ref === "number" ? ref : Math.max(0, nodes.findIndex((n) => n.name === ref));

  const tones = nodes.map((n, i) =>
    n.color === "neutral" ? NEUTRAL : resolveTone(i, n.color, n.activeColor),
  );

  const resolvedLinks = links.map((l) => ({
    source: indexOf(l.source),
    target: indexOf(l.target),
    value: l.value,
  }));

  const outflow = nodes.map((_, i) => resolvedLinks.filter((l) => l.source === i).reduce((s, l) => s + l.value, 0));
  const inflow = nodes.map((_, i) => resolvedLinks.filter((l) => l.target === i).reduce((s, l) => s + l.value, 0));
  const isSource = nodes.map((_, i) => inflow[i] === 0);
  const isSink = nodes.map((_, i) => outflow[i] === 0);
  const nodeValue = nodes.map((_, i) => Math.max(inflow[i], outflow[i]));
  const total = nodeValue.reduce((s, v, i) => (isSource[i] ? s + v : s), 0);
  const sinkTotal = nodeValue.reduce((s, v, i) => (isSink[i] ? s + v : s), 0);

  const hovering = active !== null;
  let headerLabel = title;
  let headlineValue = headline ?? total;
  if (active?.type === "node") {
    headerLabel = nodes[active.index]?.name ?? title;
    headlineValue = nodeValue[active.index] ?? headlineValue;
  } else if (active?.type === "link") {
    const l = resolvedLinks[active.index];
    if (l) {
      headerLabel = `${nodes[l.source]?.name} → ${nodes[l.target]?.name}`;
      headlineValue = l.value;
    }
  }

  const linkTouches = (linkIndex: number, nodeIndex: number) => {
    const l = resolvedLinks[linkIndex];
    return !!l && (l.source === nodeIndex || l.target === nodeIndex);
  };

  const nodeOpacity = (i: number) => {
    if (!active) return 1;
    if (active.type === "node") {
      if (active.index === i) return 1;
      const connected = resolvedLinks.some(
        (l, li) => (l.source === active.index || l.target === active.index) && linkTouches(li, i),
      );
      return connected ? 1 : 0.35;
    }
    return linkTouches(active.index, i) ? 1 : 0.35;
  };

  const linkOpacity = (li: number) => {
    if (!active) return 0.32;
    if (active.type === "link") return active.index === li ? 0.7 : 0.08;
    return linkTouches(li, active.index) ? 0.7 : 0.08;
  };

  const renderNode = (props: SankeyNodeProps) => {
    const { x, y, width, height, index } = props;
    const tone = tones[index] ?? NEUTRAL;
    const isActive = active?.type === "node" && active.index === index;
    const opacity = nodeOpacity(index);
    const source = isSource[index];
    const sink = isSink[index];
    const share = sinkTotal > 0 ? Math.round((nodeValue[index] / sinkTotal) * 100) : 0;
    const midY = y + height / 2;
    return (
      <g
        className="transition-opacity duration-200 ease-out"
        opacity={opacity}
        onMouseEnter={() => setActive({ type: "node", index })}
        onMouseLeave={() => setActive(null)}
      >
        <path
          d={nodePath(x, y, width, height, source, sink)}
          fill={isActive ? tone.activeColor : tone.color}
          className="transition-[fill] duration-150 ease-out"
        />
        {source && !sink && (
          <g className="pointer-events-none">
            <text
              x={x - 8}
              y={midY}
              dy={height >= 26 ? -2 : 4}
              textAnchor="end"
              fontSize={13}
              fontWeight={500}
              fill="var(--color-text-primary)"
            >
              {nodes[index].name}
            </text>
            {height >= 26 && (
              <text
                x={x - 8}
                y={midY}
                dy={14}
                textAnchor="end"
                fontSize={12}
                fill="var(--color-text-tertiary)"
                className="tabular-nums"
              >
                {format(nodeValue[index])}
              </text>
            )}
          </g>
        )}
        {sink && (
          <text
            x={x + width + 8}
            y={midY}
            dy={4}
            textAnchor="start"
            fontSize={13}
            className="pointer-events-none"
          >
            <tspan fontWeight={500} fill="var(--color-text-primary)">
              {nodes[index].name}
            </tspan>
            <tspan fill="var(--color-text-tertiary)" className="tabular-nums">
              {` · ${share}%`}
            </tspan>
          </text>
        )}
      </g>
    );
  };

  const renderLink = (props: SankeyLinkProps) => {
    const { sourceX, targetX, sourceY, targetY, sourceControlX, targetControlX, linkWidth, index } = props;
    const link = resolvedLinks[index];
    const endIndex = (linkColor === "target" ? link?.target : link?.source) ?? 0;
    const tone = tones[endIndex] ?? NEUTRAL;
    const boost = tone === NEUTRAL ? 1.6 : 1;
    return (
      <path
        d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
        fill="none"
        stroke={tone.color}
        strokeWidth={Math.max(1, linkWidth)}
        strokeOpacity={Math.min(0.85, linkOpacity(index) * boost)}
        className="transition-[stroke-opacity] duration-200 ease-out"
        onMouseEnter={() => setActive({ type: "link", index })}
        onMouseLeave={() => setActive(null)}
      />
    );
  };

  return (
    // Taller than the other chart cards: a flow diagram needs vertical room
    // for every node and ribbon to stay legible, so it runs 480px by default
    // (override with `className`).
    <ChartCard className={cx("h-[480px]", className)}>
      <ChartHeader
        label={headerLabel}
        value={headlineValue}
        format={format}
        delta={delta !== undefined ? describeDelta(delta) : undefined}
        hovering={hovering}
        fadeKey={`${selectedId ?? ""}:${active ? `${active.type}:${active.index}` : "idle"}`}
        range={range}
        ranges={rangeList}
        rangeId={selectedId}
        onRangeChange={selectRange}
      />

      <div className="relative min-h-0 w-full flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={{ nodes: nodes.map((n) => ({ name: n.name })), links: resolvedLinks }}
            nodeWidth={12}
            nodePadding={14}
            linkCurvature={0.55}
            iterations={32}
            sort={false}
            margin={{ top: 2, bottom: 2, left: LABEL_LEFT, right: LABEL_RIGHT }}
            node={renderNode}
            link={renderLink}
          />
        </ResponsiveContainer>
      </div>

      {axisLabels && (
        <div className="flex w-full justify-between pb-1 text-caption-1-medium text-text-tertiary">
          <span>{axisLabels[0]}</span>
          <span>{axisLabels[1]}</span>
        </div>
      )}
    </ChartCard>
  );
}
