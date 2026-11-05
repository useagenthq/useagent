"use client";

import { type ReactNode, useCallback, useRef, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import * as Modal from "@/components/base/modal/modal";
import { workpieceCloseStep } from "@/components/chat/workpiece-close";

/** What the Workspace pane needs from a mounted editor to close its tab safely. */
export interface WorkpieceEditorHandle {
  readonly dirty: () => boolean;
  /** Resolves true once the edits are stored. */
  readonly save: () => Promise<boolean>;
}
/** The mounted editors by tab id; each editor adds itself and removes itself on unmount. */
export type WorkpieceEditors = Map<string, WorkpieceEditorHandle>;

interface Tab {
  readonly id: string;
  readonly name: string;
}

export type WorkpieceCloseChoice = "save" | "discard" | "cancel";

export interface WorkpieceCloseGuard {
  /** Register each mounted editor here under its tab id. */
  readonly editors: WorkpieceEditors;
  /** The tab strip's close: closes a clean tab, asks for one with unsaved edits. */
  readonly requestClose: (id: string) => void;
  /** The tab waiting on an answer, or null. */
  readonly asking: Tab | null;
  readonly saving: boolean;
  /** Answers the question for the waiting tab. */
  readonly choose: (choice: WorkpieceCloseChoice) => Promise<void>;
  /** The Save / Discard dialog, rendered while a tab is waiting. */
  readonly dialog: ReactNode;
}

/**
 * Guards closing a Workspace tab: a tab with unsaved edits asks Save or Discard
 * (see ./workpiece-close), every other tab closes at once. A save that fails
 * keeps the tab open and brings it forward, where the editor shows the error.
 */
export function useWorkpieceCloseGuard({
  tabs,
  onClose,
  onSelect,
}: {
  readonly tabs: readonly Tab[];
  readonly onClose: (id: string) => void;
  readonly onSelect: (id: string) => void;
}): WorkpieceCloseGuard {
  const editorsRef = useRef<WorkpieceEditors>(new Map());
  const [asking, setAsking] = useState<Tab | null>(null);
  const [saving, setSaving] = useState(false);
  // Set at once, so a second click before the re-render cannot start a second save.
  const busyRef = useRef(false);
  // Read after an awaited save: the tab may have gone, or the question been
  // cancelled, in the meantime.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const askingRef = useRef(asking);
  askingRef.current = asking;

  const requestClose = useCallback(
    (id: string) => {
      const editor = editorsRef.current.get(id);
      if (workpieceCloseStep(editor && { dirty: editor.dirty() }) === "close") {
        onClose(id);
        return;
      }
      setAsking(tabs.find((tab) => tab.id === id) ?? null);
    },
    [onClose, tabs],
  );

  const choose = async (choice: WorkpieceCloseChoice) => {
    const tab = asking;
    if (!tab) return;
    // Cancel always answers, even while a save runs: a save that never returns
    // must not trap the page behind the dialog.
    if (choice === "cancel") {
      setAsking(null);
      return;
    }
    if (busyRef.current) return;
    let closes = true;
    const editor = editorsRef.current.get(tab.id);
    // Autosave may have stored the edits while the dialog was open.
    if (choice === "save" && editor?.dirty()) {
      busyRef.current = true;
      setSaving(true);
      try {
        closes = await editor.save();
      } catch {
        closes = false;
      } finally {
        busyRef.current = false;
        setSaving(false);
      }
    }
    if (askingRef.current !== tab) return;
    setAsking(null);
    if (!tabsRef.current.some((open) => open.id === tab.id)) return;
    if (closes) onClose(tab.id);
    else onSelect(tab.id);
  };

  const dialog = (
    <Modal.Root
      open={asking !== null}
      onOpenChange={(open) => {
        if (!open) void choose("cancel");
      }}
    >
      <Modal.Content className="max-w-[400px] rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown">
        <Modal.Header
          title={asking ? `Save changes to ${asking.name}?` : "Save changes?"}
          description="Your latest edits are not saved yet. Closing without saving discards them."
        />
        <Modal.Footer className="justify-end">
          <WorkpieceCloseActions saving={saving} onChoose={(choice) => void choose(choice)} />
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );

  return { editors: editorsRef.current, requestClose, asking, saving, choose, dialog };
}

/** The dialog's answers, free of Radix so tests can render them without its portal.
 * Cancel stays live while a save runs; Discard waits, since that save may still land. */
export function WorkpieceCloseActions({
  saving,
  onChoose,
}: {
  readonly saving: boolean;
  readonly onChoose: (choice: WorkpieceCloseChoice) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="secondary" size="small" onClick={() => onChoose("cancel")}>
        Cancel
      </Button>
      <Button
        variant="secondary"
        size="small"
        disabled={saving}
        onClick={() => onChoose("discard")}
      >
        Discard
      </Button>
      <Button variant="primary" size="small" disabled={saving} onClick={() => onChoose("save")}>
        {saving ? "Saving..." : "Save"}
      </Button>
    </div>
  );
}
