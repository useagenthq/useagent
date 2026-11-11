"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { InputBase, TextField } from "@/components/base/input/input";
import { listWorkspaces, useSession, type Workspace, workspacesChanged } from "@/lib/auth";
import { cx } from "@/utils/cx";
import { canManageTeam, renameWorkspace } from "./team-api";
import { ThemeToggle } from "./theme-toggle";
import { SettingsCard, SettingsRow } from "./settings-rows";

/**
 * General card - profile details read from the live better-auth session and
 * the workspace's name from the same workspace list the user menu reads, so a
 * rename on the welcome page shows here. Owners and admins rename the
 * workspace in place; every other value renders as text ("Not set" when there
 * is none) rather than as an input that ignores typing. Client component
 * because ThemeToggle can't cross the server boundary.
 */

export const AVATAR_GRADIENT = "bg-gradient-to-br from-purple-400 to-blue-500 text-white";

/** What the card needs from the workspace the session is in. */
export type ActiveWorkspace = Pick<Workspace, "id" | "name" | "role">;

/** A read-only value; `null` while the session is still loading. */
function Value({ value }: { value: string | null }) {
  if (value === null) return null;
  return (
    <p className={cx("text-body-2-regular", value ? "text-text-primary" : "text-text-secondary")}>
      {value || "Not set"}
    </p>
  );
}

/** The workspace the session is in; null when the list names none, which the
 *  card reports as a failed read rather than an unset name. */
export function activeWorkspace(
  workspaces: readonly Pick<Workspace, "id" | "name" | "role" | "active">[],
): ActiveWorkspace | null {
  const row = workspaces.find((workspace) => workspace.active);
  return row ? { id: row.id, name: row.name, role: row.role } : null;
}

/** The rename an owner or admin gets in place: Save sends the trimmed name,
 *  the server's refusal shows under the field, and a saved name tells every
 *  open workspace list (the user menu) to read again. */
function WorkspaceNameField({
  workspace,
  onRenamed,
}: {
  workspace: ActiveWorkspace;
  onRenamed: (name: string) => void;
}) {
  const [draft, setDraft] = useState(workspace.name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  // The field as typed right now, read when a save settles.
  const typed = useRef(workspace.name);
  const trimmed = draft.trim();
  const canSave = trimmed !== "" && trimmed !== workspace.name && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await renameWorkspace(workspace.id, trimmed);
      onRenamed(trimmed);
      workspacesChanged();
      // Typing during the save leaves unsaved text in the field: no "Saved"
      // beside it. Otherwise the field shows the name exactly as saved.
      if (typed.current.trim() === trimmed) {
        typed.current = trimmed;
        setDraft(trimmed);
        setSaved(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename the workspace.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-1 sm:w-72"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-2">
        <TextField
          aria-label="Workspace name"
          size="small"
          value={draft}
          onChange={(next) => {
            typed.current = next;
            setDraft(next);
            setSaved(false);
          }}
          isInvalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          className="min-w-0 flex-1"
        >
          <InputBase autoComplete="off" spellCheck={false} />
        </TextField>
        <Button
          type="submit"
          variant="secondary"
          size="small"
          className="rounded-full"
          disabled={!canSave}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      ) : saved ? (
        <p role="status" className="text-caption-1-regular text-text-tertiary">
          Saved.
        </p>
      ) : null}
    </form>
  );
}

export function GeneralCard({ initialWorkspace }: { initialWorkspace?: ActiveWorkspace } = {}) {
  const { session, loading } = useSession();
  const name = loading ? null : (session?.user.name?.trim() ?? "");
  const email = loading ? null : (session?.user.email ?? "");
  /** The active workspace; null while it loads. */
  const [workspace, setWorkspace] = useState<ActiveWorkspace | null>(initialWorkspace ?? null);
  const [workspaceFailed, setWorkspaceFailed] = useState(false);
  const seeded = initialWorkspace !== undefined;

  useEffect(() => {
    if (seeded) return;
    let cancelled = false;
    listWorkspaces()
      .then((workspaces) => {
        if (cancelled) return;
        const active = activeWorkspace(workspaces);
        if (active === null) setWorkspaceFailed(true);
        else setWorkspace(active);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [seeded]);

  return (
    <SettingsCard>
      <SettingsRow label="Name">
        <Value value={name} />
      </SettingsRow>
      <SettingsRow label="Email">
        <Value value={email} />
      </SettingsRow>
      <SettingsRow label="Workspace name">
        {workspaceFailed ? (
          <p className="text-body-2-regular text-text-error-primary">Could not load the workspace.</p>
        ) : workspace && canManageTeam(workspace.role) ? (
          <WorkspaceNameField
            key={workspace.id}
            workspace={workspace}
            onRenamed={(renamed) =>
              setWorkspace((current) => (current ? { ...current, name: renamed } : current))
            }
          />
        ) : (
          <Value value={workspace?.name ?? null} />
        )}
      </SettingsRow>
      <SettingsRow label="Theme" description="Choose your interface theme.">
        <ThemeToggle />
      </SettingsRow>
    </SettingsCard>
  );
}
