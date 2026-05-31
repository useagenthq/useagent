"use client";

import { RiAttachment2, RiGithubLine } from "@remixicon/react";
import { cx } from "@/utils/cx";

/**
 * Shared "+" add-context menu rows, consumed by BOTH composers so the grammar
 * stays identical:
 *  - the new-thread composer (`app/agent/new/new-task-composer.tsx`) lays them
 *    out as one attached shelf under the card, and
 *  - the reply composer (`components/chat/composer.tsx`) floats them in a popover
 *    above the input.
 *
 * Only REAL reply/new-run capabilities live here. Uploads are wired end-to-end
 * for both a new run and a reply (POST /api/uploads -> attachments ride POST
 * /api/runs, claimed + materialized into the sandbox); the Create rows seed the
 * prompt with a real artifact task the agent can execute. Repository selection
 * and the GitHub status row are NEW-RUN only (a reply reuses the thread's already
 * provisioned sandbox), so the reply popover omits them.
 */

/** Full-width row styling for a control inside the "+" add-context menu. */
export const ADD_MENU_ROW =
  "flex w-full items-center gap-3 rounded-2lg px-2.5 py-2 text-left text-body-2-medium text-text-primary transition-colors hover:bg-background-primary-hover";

/** "Create" actions: the colored BoardUI plugin icons (public/plugin-icons) that
 *  seed the prompt with a real artifact-creation task the agent can execute (it
 *  genuinely makes documents, spreadsheets, decks, code). */
export const CREATE_ROWS = [
  { icon: "/plugin-icons/plugin-documents.svg", label: "Document", desc: "Write and edit a document", seed: "Create a document that " },
  { icon: "/plugin-icons/plugin-spreadsheets.svg", label: "Spreadsheet", desc: "Generate a spreadsheet", seed: "Create a spreadsheet that " },
  { icon: "/plugin-icons/plugin-presentations.svg", label: "Presentation", desc: "Build a slide deck", seed: "Create a presentation that " },
  { icon: "/plugin-icons/plugin-codeblocks.svg", label: "Code", desc: "Write and edit code", seed: "Write code that " },
] as const;

/** The "Add photos & files" row - a real upload via runUploads (POST /api/uploads).
 *  `onPick` opens the hidden file input owned by the composer. */
export function AddFilesRow({ onPick }: { onPick: () => void }) {
  return (
    <button type="button" onClick={onPick} className={ADD_MENU_ROW}>
      <RiAttachment2 className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-2-medium text-text-primary">Add photos &amp; files</span>
        <span className="text-caption-1-regular text-text-tertiary">Upload from computer</span>
      </span>
    </button>
  );
}

/** The "Create" section: a label + the colored plugin rows. `onSeed(seed)` hands
 *  the caller the seed text so it can apply its own "only when empty" rule. */
export function CreateRows({ onSeed }: { onSeed: (seed: string) => void }) {
  return (
    <>
      <p className="px-2.5 pb-0.5 pt-0.5 text-mono-label text-text-tertiary">Create</p>
      {CREATE_ROWS.map((row) => (
        <button key={row.label} type="button" onClick={() => onSeed(row.seed)} className={ADD_MENU_ROW}>
          <img src={row.icon} alt="" width={20} height={20} className="size-5 shrink-0" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body-2-medium text-text-primary">{row.label}</span>
            <span className="text-caption-1-regular text-text-tertiary">{row.desc}</span>
          </span>
        </button>
      ))}
    </>
  );
}

/** GitHub is connected server-side via the GitHub App - a status row, not an
 *  action. New-run shelf only (a reply reuses the thread's sandbox). */
export function GithubConnectedRow() {
  return (
    <div className={cx(ADD_MENU_ROW, "cursor-default hover:bg-transparent")}>
      <RiGithubLine className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-2-medium text-text-primary">GitHub</span>
        <span className="text-caption-1-regular text-text-tertiary">
          Read pull requests &amp; issues
        </span>
      </span>
      <span className="rounded-full bg-background-secondary-default px-2 py-0.5 text-caption-1-medium text-text-secondary">
        Connected
      </span>
    </div>
  );
}

/** Full-bleed section divider inside the add-context menu. */
export function AddMenuDivider() {
  return <div className="my-1 border-t border-border-button-default" />;
}
