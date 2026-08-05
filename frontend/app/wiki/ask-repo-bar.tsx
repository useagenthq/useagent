"use client";

import { useState } from "react";
import { RiArrowUpLine, RiCheckLine } from "@remixicon/react";

import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import { backendFetch } from "@/lib/backend-fetch";
import { cnExt } from "@/utils/cn";

/**
 * The "Ask about this repo" bar pinned to the bottom of the wiki. Mirrors the
 * home composer's send affordance (blue circular button) but scoped to a
 * single-line question; submitting hands the query off to a fresh agent run
 * via `POST /api/runs`, then flashes a brief confirmation.
 */

type Status = "idle" | "sending" | "sent";

export function AskRepoBar() {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  const busy = status === "sending";

  async function submit() {
    const prompt = value.trim();
    if (!prompt || busy) return;
    setStatus("sending");
    try {
      const res = await backendFetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: `About the skynet-app repo: ${prompt}`,
        }),
      });
      if (!res.ok) throw new Error(`runs ${res.status}`);
      setValue("");
      setStatus("sent");
      setTimeout(() => setStatus("idle"), 1600);
    } catch {
      setStatus("idle");
    }
  }

  return (
    <div className="sticky bottom-4 z-10 mt-12">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex items-center gap-3 rounded-2xl bg-bg-white-0 px-3.5 py-2.5 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200"
      >
        <AsteriskMark className="size-5 shrink-0 text-text-strong-950" />
        <input
          type="text"
          aria-label="Ask about this repo"
          placeholder="Ask anything about skynet-app…"
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400 disabled:opacity-60"
        />
        <button
          type="submit"
          aria-label="Ask about this repo"
          disabled={busy || !value.trim()}
          className={cnExt(
            "flex size-8 shrink-0 items-center justify-center rounded-full text-static-white outline-none transition-opacity",
            "focus-visible:ring-2 focus-visible:ring-primary-base focus-visible:ring-offset-2",
            status === "sent" ? "bg-success-base" : "bg-primary-base",
            "hover:opacity-90 disabled:opacity-40",
          )}
        >
          {status === "sent" ? (
            <RiCheckLine className="size-5" aria-hidden />
          ) : (
            <RiArrowUpLine className="size-5" aria-hidden />
          )}
        </button>
      </form>
    </div>
  );
}
