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
    <div className="flex h-80 w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-md">
      <div className="flex items-center justify-between border-b border-border-button-default p-2">
        <div className="flex gap-1">
          {tabs.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={tab === item}
              onClick={() => setTab(item)}
              className={`rounded-md px-2 py-1 text-body-2-medium transition-colors ${tab === item ? "bg-background-secondary-default text-text-primary" : "text-text-tertiary hover:text-text-secondary"}`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="flex text-text-tertiary">
          {chatActions.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-label={label}
              className="rounded-md p-1 hover:bg-background-primary-hover"
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
            className="ml-auto max-w-[82%] rounded-xl bg-background-secondary-default px-3 py-2 text-body-2-regular text-text-primary"
          >
            {message.text}
          </div>
        ))}
        <div className="space-y-1 text-body-2-regular text-text-secondary">
          <p>
            <strong className="text-text-primary">Sales History</strong> pulled three summers of
            flavor data.
          </p>
          <p>
            <strong className="text-text-primary">Comparison</strong> found stronger weekend
            peaks.
          </p>
        </div>
      </div>

      <div className="p-2">
        <div className="flex items-center gap-2 rounded-xl border border-border-button-default bg-background-secondary-default p-2 focus-within:border-border-button-hover">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && send()}
            aria-label="Chat prompt"
            placeholder="Prompt or tag a flavor with @"
            className="min-w-0 flex-1 bg-transparent text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder"
          />
          <button
            type="button"
            aria-label="Send"
            disabled={!draft.trim()}
            onClick={send}
            className="rounded-lg bg-button-primary p-1.5 text-text-white disabled:opacity-30"
          >
            <RiArrowUpLine className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
