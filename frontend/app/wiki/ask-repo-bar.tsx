"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RiArrowUpLine } from "@remixicon/react";

import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import { backendFetch } from "@/lib/backend-fetch";
import { cnExt } from "@/utils/cn";

/**
 * The "Ask the wiki" bar pinned to the bottom of the wiki. Submitting starts a
 * real agent run scoped to the org's published wiki (the agent holds the
 * knowledge_search/knowledge_read gateway tools, so it answers FROM these
 * documents with citations) and NAVIGATES to that session so the answer is
 * actually seen - the old version fired the run, flashed a checkmark, and left
 * the user stranded on this page with a stale hardcoded repo name.
 */

type Status = "idle" | "sending";

export function AskRepoBar() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [failed, setFailed] = useState(false);

  const busy = status === "sending";

  async function submit() {
    const prompt = value.trim();
    if (!prompt || busy) return;
    setStatus("sending");
    setFailed(false);
    try {
      const res = await backendFetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: `Answer from the organization wiki (use knowledge_search and knowledge_read; cite the documents you used): ${prompt}`,
        }),
      });
      if (!res.ok) throw new Error(`runs ${res.status}`);
      const created = (await res.json()) as { id?: string; run?: { id?: string } };
      const id = created.id ?? created.run?.id;
      if (!id) throw new Error("no run id");
      router.push(`/session/${id}`);
    } catch {
      setFailed(true);
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
          aria-label="Ask the wiki"
          placeholder={busy ? "Starting a session..." : "Ask the wiki anything; an agent answers from these documents"}
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400 disabled:opacity-60"
        />
        {failed && (
          <span className="text-label-xs text-error-base shrink-0">Could not start, retry</span>
        )}
        <button
          type="submit"
          aria-label="Ask the wiki"
          disabled={busy || !value.trim()}
          className={cnExt(
            "flex size-8 shrink-0 items-center justify-center rounded-full text-static-white outline-none transition-opacity",
            "focus-visible:ring-2 focus-visible:ring-primary-base focus-visible:ring-offset-2",
            "bg-primary-base",
            "hover:opacity-90 disabled:opacity-40",
          )}
        >
          <RiArrowUpLine className="size-5" aria-hidden />
        </button>
      </form>
    </div>
  );
}
