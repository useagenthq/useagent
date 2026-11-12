"use client";

import { RiArrowLeftLine, RiDownload2Line, RiUpload2Line } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import * as Modal from "@/components/base/modal/modal";
import { AvatarMark } from "./avatar-mark";
import {
  type BotFileDraft,
  type BotImportResult,
  exportBot,
  importBot,
  importNotes,
  readBotFile,
} from "./bot-file";
import { type ApiBot, engineLabel } from "./types";

/** In the details drawer: download the bot as a file another workspace can import. */
export function ExportBotSection({ bot }: { bot: ApiBot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(await exportBot(bot));
    setBusy(false);
  };

  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-body-2-medium text-text-primary">Share</h2>
      <p className="text-body-2-regular text-text-secondary">
        Download this bot as a file to import it into another workspace. Its routines come along,
        turned off. Its threads and the people in this workspace stay here.
      </p>
      <div>
        <Button
          variant="secondary"
          size="small"
          leadingIcon={RiDownload2Line}
          onClick={() => void run()}
        >
          {busy ? "Exporting…" : "Export bot"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      )}
    </section>
  );
}

/** In the New bot dialog's footer: choose a bot file. A file that is not one is reported through `onError`. */
export function ImportFromFileButton({
  onOpen,
  onError,
}: {
  onOpen: (draft: BotFileDraft) => void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const open = async (file: File) => {
    const read = readBotFile(await file.text().catch(() => ""));
    if ("error" in read) return onError(read.error);
    onOpen(read.draft);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void open(file);
        }}
      />
      <Button
        variant="ghost"
        size="small"
        leadingIcon={RiUpload2Line}
        onClick={() => inputRef.current?.click()}
      >
        Import from file
      </Button>
    </>
  );
}

function routinesLine(count: number): string {
  if (count === 0) return "No routines.";
  return `${count === 1 ? "1 routine" : `${count} routines`}, imported turned off.`;
}

/**
 * The New bot dialog after a bot file is chosen: what the file holds, its name
 * (editable, since a name can already be taken here) and Import. When the
 * import left something out, the dialog says what before opening the bot.
 */
export function ImportBotPanel({
  draft,
  onBack,
  onClose,
}: {
  draft: BotFileDraft;
  onBack: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(draft.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<BotImportResult | null>(null);
  const notes = imported ? importNotes(imported) : [];
  // The control that chose the file is gone once this panel shows: focus the name.
  useEffect(() => nameRef.current?.focus(), []);

  const open = (bot: ApiBot) => {
    onClose();
    router.push(`/bots/${bot.id}`);
    router.refresh();
  };

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) {
      setNameError("Give the bot a name.");
      return nameRef.current?.focus();
    }
    setBusy(true);
    setError(null);
    const outcome = await importBot(draft, name.trim());
    setBusy(false);
    if ("error" in outcome) {
      if (outcome.field === "name") {
        setNameError(outcome.error);
        return nameRef.current?.focus();
      }
      return setError(outcome.error);
    }
    if (importNotes(outcome.result).length === 0) return open(outcome.result.bot);
    setImported(outcome.result);
    // The bot exists now, whether or not Open bot is chosen: the roster shows it.
    router.refresh();
  };

  return (
    <>
      <Modal.Header>
        <Modal.Title className="text-title-3-medium text-text-primary">Import bot</Modal.Title>
      </Modal.Header>
      <Modal.Body className="flex flex-col gap-5 pt-2">
        <div className="flex flex-col items-center gap-3">
          <AvatarMark tone={draft.avatarTone} icon={draft.avatarIcon} size="size-16" />
          {draft.title && (
            <p className="text-center text-body-2-regular text-text-secondary">{draft.title}</p>
          )}
        </div>
        {imported ? (
          <div className="flex flex-col gap-2" role="status">
            <p className="text-body-2-medium text-text-primary">{imported.bot.name} is ready.</p>
            {notes.map((note) => (
              <p key={note} className="text-body-2-regular text-text-secondary">
                {note}
              </p>
            ))}
          </div>
        ) : (
          <>
            <Input
              ref={nameRef}
              label="Name"
              placeholder="Bot name"
              value={name}
              onChange={(value) => {
                setName(value);
                setNameError(null);
              }}
              isInvalid={nameError !== null}
              hint={nameError ?? undefined}
            />
            <dl className="flex flex-col gap-1 text-body-2-regular">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-text-tertiary">Engine</dt>
                <dd className="text-text-primary">
                  {draft.engine ? engineLabel(draft.engine) : "Not set"}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-text-tertiary">Repositories</dt>
                <dd className="min-w-0 break-words text-text-primary">
                  {draft.repos.length > 0 ? draft.repos.join(", ") : "None"}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-text-tertiary">Routines</dt>
                <dd className="text-text-primary">{routinesLine(draft.routines)}</dd>
              </div>
            </dl>
            {error && (
              <p role="alert" className="text-body-2-regular text-text-error-primary">
                {error}
              </p>
            )}
          </>
        )}
      </Modal.Body>
      <Modal.Footer className={imported ? "justify-end" : undefined}>
        {imported ? (
          <Button variant="primary" size="small" onClick={() => open(imported.bot)}>
            Open bot
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="small" leadingIcon={RiArrowLeftLine} onClick={onBack}>
              Back
            </Button>
            <div className="flex items-center gap-2">
              <Modal.Close asChild>
                <Button variant="secondary" size="small">
                  Cancel
                </Button>
              </Modal.Close>
              <Button variant="primary" size="small" onClick={() => void submit()}>
                {busy ? "Importing…" : "Import bot"}
              </Button>
            </div>
          </>
        )}
      </Modal.Footer>
    </>
  );
}
