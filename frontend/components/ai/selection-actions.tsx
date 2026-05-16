"use client";

import { RiCheckLine, RiMagicLine, RiScissorsLine, RiSparkling2Line } from "@remixicon/react";
import * as React from "react";

const original =
  "Churn it first thing Saturday so the batch has time to firm up before the afternoon rush.";
const rewrite =
  "Churn pistachio first thing Saturday so the batch has time to fully firm before the afternoon rush.";

export function SelectionActions() {
  const [result, setResult] = React.useState(original);
  const [busy, setBusy] = React.useState(false);
  const [accepted, setAccepted] = React.useState(false);

  function transform(action: "Improve" | "Shorten") {
    setBusy(true);
    setAccepted(false);
    window.setTimeout(() => {
      setResult(
        action === "Improve" ? rewrite : "Churn pistachio Saturday morning before the rush.",
      );
      setBusy(false);
    }, 450);
  }

  return (
    <div className="w-full max-w-2xl rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-5 shadow-regular-md">
      <p className="text-paragraph-md leading-7 text-text-sub-600">
        Pistachio holds the top slot all weekend.{" "}
        <mark className="rounded bg-primary-lighter px-1 text-text-strong-950">{result}</mark>
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-1 rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-1.5 shadow-regular-sm">
        <button
          type="button"
          onClick={() => transform("Improve")}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-paragraph-xs text-text-sub-600 hover:bg-bg-weak-50"
        >
          <RiSparkling2Line className="size-4" />
          Improve
        </button>
        <button
          type="button"
          onClick={() => transform("Shorten")}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-paragraph-xs text-text-sub-600 hover:bg-bg-weak-50"
        >
          <RiScissorsLine className="size-4" />
          Shorten
        </button>
        <span className="mx-1 h-5 w-px bg-stroke-soft-200" />
        {busy ? (
          <span className="agent-progress-loading-text px-2 text-paragraph-xs">Rewriting</span>
        ) : (
          <button
            type="button"
            onClick={() => setAccepted(true)}
            className="ml-auto flex items-center gap-1 rounded-lg bg-text-strong-950 px-2.5 py-1.5 text-paragraph-xs text-bg-white-0"
          >
            {accepted ? <RiCheckLine className="size-4" /> : <RiMagicLine className="size-4" />}
            {accepted ? "Accepted" : "Use rewrite"}
          </button>
        )}
      </div>
    </div>
  );
}
