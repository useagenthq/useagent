"use client";

import { RiAddLine, RiArrowUpLine, RiAtLine, RiCommandLine, RiMicLine } from "@remixicon/react";
import * as React from "react";

const sources = ["Sales history", "Flavor records", "Web search", "Slack"];
const commands = ["/compare", "/churn-plan", "/restock", "/summarize"];
const models = ["Sprinkles 5", "Vanilla 1", "Freezer Burn 0.4"];

export function PromptBar() {
  const [draft, setDraft] = React.useState("");
  const [model, setModel] = React.useState(models[1]);
  const [attachments, setAttachments] = React.useState<string[]>([]);
  const [listening, setListening] = React.useState(false);
  const token = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  const menu = token?.[2] === "@" ? sources : token?.[2] === "/" ? commands : [];
  const query = token?.[3]?.toLowerCase() ?? "";
  const options = menu.filter((option) => option.toLowerCase().includes(query));

  function choose(value: string) {
    if (!token) return;
    setDraft(`${draft.slice(0, token.index + token[1].length)}${value} `);
  }

  return (
    <div className="relative w-full max-w-2xl">
      {options.length ? (
        <div className="absolute inset-x-0 bottom-full z-10 mb-2 rounded-xl border border-border-button-default bg-background-primary-default p-1.5 shadow-lg">
          {options.map((option) => (
            <button
              type="button"
              key={option}
              onClick={() => choose(option)}
              className="flex w-full rounded-lg px-3 py-2 text-left text-body-2-regular text-text-secondary hover:bg-background-primary-hover"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-2 shadow-md focus-within:border-border-button-hover">
        {attachments.length ? (
          <div className="mb-2 flex flex-wrap gap-1">
            {attachments.map((file) => (
              <button
                type="button"
                key={file}
                onClick={() => setAttachments((current) => current.filter((item) => item !== file))}
                className="rounded-md bg-background-secondary-default px-2 py-1 text-caption-1-regular text-text-secondary"
              >
                {file} ×
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Prompt"
          placeholder="Ask anything, use @ for sources or / for commands"
          rows={2}
          className="w-full resize-none bg-transparent px-1 text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder"
        />
        <div className="flex items-center gap-1 text-text-tertiary">
          <button
            type="button"
            aria-label="Add attachment"
            onClick={() =>
              setAttachments((current) =>
                current.includes("flavor-chart.png") ? current : [...current, "flavor-chart.png"],
              )
            }
            className="rounded-lg p-1.5 hover:bg-background-primary-hover"
          >
            <RiAddLine className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Add source"
            onClick={() => setDraft((current) => `${current}@`)}
            className="rounded-lg p-1.5 hover:bg-background-primary-hover"
          >
            <RiAtLine className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Add command"
            onClick={() => setDraft((current) => `${current}/`)}
            className="rounded-lg p-1.5 hover:bg-background-primary-hover"
          >
            <RiCommandLine className="size-4" />
          </button>
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
            aria-label="Choose model"
            className="ml-auto rounded-lg bg-background-secondary-default px-2 py-1.5 text-caption-1-regular text-text-secondary outline-none"
          >
            {models.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <button
            type="button"
            aria-label={listening ? "Stop dictation" : "Start dictation"}
            aria-pressed={listening}
            onClick={() => setListening((current) => !current)}
            className={`rounded-lg p-1.5 ${listening ? "bg-status-rose-background text-status-rose-text" : "hover:bg-background-primary-hover"}`}
          >
            <RiMicLine className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Send"
            disabled={!draft.trim()}
            className="rounded-lg bg-button-primary p-1.5 text-text-white disabled:opacity-30"
          >
            <RiArrowUpLine className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
