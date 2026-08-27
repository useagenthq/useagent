"use client";

import { RiAttachment2, RiGithubLine } from "@remixicon/react";
import type { ReactNode } from "react";
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
  "flex w-full cursor-pointer items-center gap-2.5 rounded-2lg px-2.5 py-1.5 text-left text-body-2-medium text-text-primary transition-colors hover:bg-background-primary-hover";

/** "Create" actions: the colored BoardUI plugin icons (public/plugin-icons) that
 *  seed the prompt with a real artifact-creation task the agent can execute (it
 *  genuinely makes documents, spreadsheets, decks, code). */
export const CREATE_ROWS = [
  { icon: "/plugin-icons/plugin-documents.svg", label: "Document", desc: "Write and edit a document", seed: "Create a document that " },
  { icon: "/plugin-icons/plugin-spreadsheets.svg", label: "Spreadsheet", desc: "Generate a spreadsheet", seed: "Create a spreadsheet that " },
  { icon: "/plugin-icons/plugin-presentations.svg", label: "Presentation", desc: "Build a slide deck", seed: "Create a presentation that " },
  { icon: "/plugin-icons/plugin-codeblocks.svg", label: "Code", desc: "Write and edit code", seed: "Write code that " },
] as const;

/** Text block for an add-menu row. `inline` lays the title and muted
 *  description on ONE line (floating-popover style); the default stacks them. */
function RowText({
  inline,
  title,
  description,
}: {
  inline: boolean;
  title: ReactNode;
  description: ReactNode;
}) {
  return (
    <span className={cx("flex min-w-0 flex-1", inline ? "flex-row items-center gap-2" : "flex-col")}>
      <span className="shrink-0 text-body-2-medium text-text-primary">{title}</span>
      <span
        className={cx(
          "truncate text-text-tertiary",
          "text-caption-1-regular",
        )}
      >
        {description}
      </span>
    </span>
  );
}

/** The "Add photos & files" row - a real upload via runUploads (POST /api/uploads).
 *  `onPick` opens the hidden file input owned by the composer. */
export function AddFilesRow({ onPick, inline = false }: { onPick: () => void; inline?: boolean }) {
  return (
    <button type="button" onClick={onPick} className={ADD_MENU_ROW}>
      <RiAttachment2 className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
      <RowText inline={inline} title={<>Add photos &amp; files</>} description="Upload from computer" />
    </button>
  );
}

/** The "Create" section: a label + the colored plugin rows. `onSeed(seed)` hands
 *  the caller the seed text so it can apply its own "only when empty" rule. */
export function CreateRows({ onSeed, inline = false }: { onSeed: (seed: string) => void; inline?: boolean }) {
  return (
    <>
      <p className="px-2.5 pb-0.5 pt-0.5 text-mono-label text-text-tertiary">Create</p>
      {CREATE_ROWS.map((row) => (
        <button key={row.label} type="button" onClick={() => onSeed(row.seed)} className={ADD_MENU_ROW}>
          <img src={row.icon} alt="" width={16} height={16} className="size-4 shrink-0" aria-hidden />
          <RowText inline={inline} title={row.label} description={row.desc} />
        </button>
      ))}
    </>
  );
}

/** GitHub is connected server-side via the GitHub App - a status row, not an
 *  action. New-run shelf only (a reply reuses the thread's sandbox). */
export function GithubConnectedRow({ inline = false }: { inline?: boolean }) {
  return (
    <div className={cx(ADD_MENU_ROW, "cursor-default hover:bg-transparent")}>
      <RiGithubLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
      <RowText inline={inline} title="GitHub" description={<>Read pull requests &amp; issues</>} />
      <span className="shrink-0 rounded-full bg-background-secondary-default px-2 py-0.5 text-caption-1-medium text-text-secondary">
        Connected
      </span>
    </div>
  );
}

/** Full-bleed section divider inside the add-context menu. */
export function AddMenuDivider() {
  return <div className="my-1 border-t border-border-button-default" />;
}
