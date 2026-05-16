"use client";

import * as React from "react";

const layouts = ["Row", "Column", "Grid"] as const;

function NumberField({
  label,
  value,
  min,
  max,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-1 rounded-lg bg-bg-weak-50 px-2 py-1.5">
      <span className="text-paragraph-xs text-text-soft-400">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(Math.min(max, Math.max(min, Number(event.target.value))))}
        className="min-w-0 flex-1 bg-transparent text-right text-paragraph-xs text-text-strong-950 outline-none"
      />
      {suffix ? <span className="text-paragraph-xs text-text-soft-400">{suffix}</span> : null}
    </label>
  );
}

export function FineTuneCard() {
  const [layout, setLayout] = React.useState<(typeof layouts)[number]>("Row");
  const [width, setWidth] = React.useState(324);
  const [height, setHeight] = React.useState(96);
  const [radius, setRadius] = React.useState(28);
  const [opacity, setOpacity] = React.useState(100);
  const edited =
    layout !== "Row" || width !== 324 || height !== 96 || radius !== 28 || opacity !== 100;

  return (
    <div className="w-full max-w-xs rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-md">
      <div className="flex items-center justify-between border-b border-stroke-soft-200 px-3 py-2.5">
        <span className="text-label-sm text-text-strong-950">Flavor card</span>
        <span className={`text-paragraph-xs ${edited ? "text-success-base" : "text-primary-base"}`}>
          {edited ? "Edited" : "Adjust"}
        </span>
      </div>
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-3 rounded-lg bg-bg-weak-50 p-0.5">
          {layouts.map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={layout === item}
              onClick={() => setLayout(item)}
              className={`rounded-md py-1.5 text-paragraph-xs ${layout === item ? "bg-bg-white-0 text-primary-base shadow-regular-xs" : "text-text-soft-400"}`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="W" value={width} min={40} max={999} onChange={setWidth} />
          <NumberField label="H" value={height} min={24} max={999} onChange={setHeight} />
          <NumberField label="Radius" value={radius} min={0} max={64} onChange={setRadius} />
          <NumberField
            label="Opacity"
            value={opacity}
            min={0}
            max={100}
            suffix="%"
            onChange={setOpacity}
          />
        </div>
        <label className="flex items-center justify-between text-paragraph-xs text-text-soft-400">
          Type
          <select className="rounded-lg bg-bg-weak-50 px-2 py-1.5 text-text-sub-600 outline-none">
            <option>Select type</option>
            <option>Card</option>
            <option>Panel</option>
            <option>Stack</option>
          </select>
        </label>
      </div>
    </div>
  );
}
