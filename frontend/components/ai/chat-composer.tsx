"use client";

import { RiAddLine, RiArrowUpLine, RiHistoryLine, RiMoreLine } from "@remixicon/react";
import * as React from "react";

const tabs = ["Flavors", "Suppliers"] as const;
const chatActions = [
  { id: "add", label: "Add", Icon: RiAddLine },
  { id: "history", label: "History", Icon: RiHistoryLine },
  { id: "more", label: "More", Icon: RiMoreLine },
] as const;

interface ChatMessage {
  readonly id: string;
  readonly text: string;
}

export function ChatComposer() {
  const [tab, setTab] = React.useState<(typeof tabs)[number]>("Flavors");
  const [draft, setDraft] = React.useState("");
  const [messages, setMessages] = React.useState<readonly ChatMessage[]>([
    { id: "initial-comparison", text: "Compare mint chip to last summer" },
  ]);

  function send() {
    const message = draft.trim();
    if (!message) return;
    setMessages((current) => [...current, { id: crypto.randomUUID(), text: message }]);
    setDraft("");
  }

  return (
    <div className="flex h-80 w-full max-w-md flex-col overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-md">
      <div className="flex items-center justify-between border-b border-stroke-soft-200 p-2">
        <div className="flex gap-1">
          {tabs.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={tab === item}
              onClick={() => setTab(item)}
              className={`rounded-md px-2 py-1 text-label-sm transition-colors ${tab === item ? "bg-bg-weak-50 text-text-strong-950" : "text-text-soft-400 hover:text-text-sub-600"}`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="flex text-text-soft-400">
          {chatActions.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-label={label}
              className="rounded-md p-1 hover:bg-bg-weak-50"
            >
              <Icon className="size-4" />
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {messages.map((message) => (
          <div
            key={message.id}
            className="ml-auto max-w-[82%] rounded-xl bg-bg-weak-50 px-3 py-2 text-paragraph-sm text-text-strong-950"
          >
            {message.text}
          </div>
        ))}
        <div className="space-y-1 text-paragraph-sm text-text-sub-600">
          <p>
            <strong className="text-text-strong-950">Sales History</strong> pulled three summers of
            flavor data.
          </p>
          <p>
            <strong className="text-text-strong-950">Comparison</strong> found stronger weekend
            peaks.
          </p>
        </div>
      </div>

      <div className="p-2">
        <div className="flex items-center gap-2 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-2 focus-within:border-stroke-sub-300">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && send()}
            aria-label="Chat prompt"
            placeholder="Prompt or tag a flavor with @"
            className="min-w-0 flex-1 bg-transparent text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
          />
          <button
            type="button"
            aria-label="Send"
            disabled={!draft.trim()}
            onClick={send}
            className="rounded-lg bg-text-strong-950 p-1.5 text-bg-white-0 disabled:opacity-30"
          >
            <RiArrowUpLine className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
