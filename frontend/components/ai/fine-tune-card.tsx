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
    <label className="flex items-center gap-1 rounded-lg bg-background-secondary-default px-2 py-1.5">
      <span className="text-caption-1-regular text-text-tertiary">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(Math.min(max, Math.max(min, Number(event.target.value))))}
        className="min-w-0 flex-1 bg-transparent text-right text-caption-1-regular text-text-primary outline-none"
      />
      {suffix ? <span className="text-caption-1-regular text-text-tertiary">{suffix}</span> : null}
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
    <div className="w-full max-w-60 rounded-2xl border border-border-button-default bg-background-primary-default shadow-card">
      <div className="flex items-center justify-between border-b border-border-button-default px-3 py-2.5">
        <span className="text-body-2-medium text-text-primary">Flavor card</span>
        <span className={`text-caption-1-regular ${edited ? "text-lime-600" : "text-accent-500"}`}>
          {edited ? "Edited" : "Adjust"}
        </span>
      </div>
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-3 rounded-lg bg-background-secondary-default p-0.5">
          {layouts.map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={layout === item}
              onClick={() => setLayout(item)}
              className={`rounded-md py-1.5 text-caption-1-regular ${layout === item ? "bg-background-primary-default text-accent-500 shadow-card" : "text-text-tertiary"}`}
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
        <label className="flex items-center justify-between text-caption-1-regular text-text-tertiary">
          Type
          <select className="rounded-lg bg-background-secondary-default px-2 py-1.5 text-text-secondary outline-none">
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
