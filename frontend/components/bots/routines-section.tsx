"use client";

import { RiAddLine, RiDeleteBinLine, RiPlayLine } from "@remixicon/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cadenceLabel } from "@/app/agent/schedules/schedules-data";
import { Badge } from "@/components/base/badges/badge";
import { Button } from "@/components/base/buttons/button";
import * as Modal from "@/components/base/modal/modal";
import { Switch } from "@/components/base/switch/switch";
import { NewRoutineForm } from "./routine-form";
import { deleteRoutine, fetchRoutines, runRoutineNow, updateRoutine } from "./routines-api";
import { relativeTime } from "./roster-model";
import { type ApiBot, type ApiRoutine, OFFLINE_MESSAGE } from "./types";
import { useNow } from "./use-now";

/** "Weekdays at 9:00" -> "weekdays at 9:00", for mid-sentence use. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function RoutineRow({
  bot,
  routine,
  onChange,
}: {
  bot: ApiBot;
  routine: ApiRoutine;
  /** Reload the list; an updated routine from a response is merged in first. */
  onChange: (updated?: ApiRoutine) => void;
}) {
  const now = useNow();
  const [busy, setBusy] = useState<"toggle" | "run" | "delete" | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** The run a test run started, until this row goes away. */
  const [started, setStarted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const guard = async (kind: "toggle" | "run" | "delete", work: () => Promise<ApiRoutine | undefined>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      onChange(await work());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : OFFLINE_MESSAGE);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border-button-default p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-body-2-medium text-text-primary">
            <span className="truncate" title={routine.name}>
              {routine.name}
            </span>
            {started && <Badge>Running</Badge>}
          </p>
          <p className="text-caption-1-regular text-text-tertiary">
            {cadenceLabel(routine.cron)}
            {routine.timezone ? ` (${routine.timezone})` : ""}
            {routine.lastFiredAt ? ` · last run ${relativeTime(routine.lastFiredAt, now) || "just now"}` : " · never run"}
          </p>
        </div>
        <Switch
          size="sm"
          aria-label={`${routine.name} enabled`}
          isSelected={routine.enabled}
          onChange={(enabled: boolean) =>
            void guard("toggle", async () => (await updateRoutine(bot.id, routine.id, { enabled })) ?? undefined)
          }
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="small"
            leadingIcon={RiPlayLine}
            onClick={() =>
              void guard("run", async () => {
                const fired = await runRoutineNow(bot.id, routine.id);
                setStarted(fired.runId);
                return fired.routine;
              })
            }
          >
            {busy === "run" ? "Starting…" : "Test run"}
          </Button>
          {started && (
            <span role="status" className="truncate text-caption-1-regular text-text-secondary">
              Started,{" "}
              <Link href={`/session/${started}`} className="text-text-primary underline-offset-2 hover:underline">
                view run
              </Link>
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="small"
          iconOnly
          leadingIcon={RiDeleteBinLine}
          aria-label={`Delete ${routine.name}`}
          onClick={() => setConfirming(true)}
        />
      </div>
      {error && (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      )}
      <Modal.Root open={confirming} onOpenChange={setConfirming}>
        <Modal.Content className="max-w-[400px] rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown">
          <Modal.Header
            title={`Delete ${routine.name}?`}
            description={`It stops firing ${lowerFirst(cadenceLabel(routine.cron))}.`}
          />
          <Modal.Footer className="justify-end">
            <Modal.Close asChild>
              <Button variant="secondary" size="small">
                Cancel
              </Button>
            </Modal.Close>
            <Button
              variant="danger"
              size="small"
              onClick={() => {
                setConfirming(false);
                void guard("delete", async () => {
                  await deleteRoutine(bot.id, routine.id);
                  return undefined;
                });
              }}
            >
              Delete routine
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </div>
  );
}

/**
 * Routines: schedules owned by the bot that fire into its home thread. Active
 * toggle, Test run, last run - the reference's routine pane, on our
 * automations engine.
 */
export function RoutinesSection({ bot }: { bot: ApiBot }) {
  const router = useRouter();
  const [routines, setRoutines] = useState<ApiRoutine[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      setRoutines(await fetchRoutines(bot.id));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : OFFLINE_MESSAGE);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const changed = (updated?: ApiRoutine) => {
    if (updated) setRoutines((current) => current?.map((routine) => (routine.id === updated.id ? updated : routine)) ?? null);
    void reload();
    router.refresh();
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-body-2-medium text-text-primary">Routines</h2>
        {!adding && (
          <Button variant="ghost" size="small" iconOnly leadingIcon={RiAddLine} aria-label="Add routine" onClick={() => setAdding(true)} />
        )}
      </div>
      {adding && (
        <NewRoutineForm
          bot={bot}
          onCancel={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            changed();
          }}
        />
      )}
      {routines === null && !error ? (
        <p className="text-caption-1-regular text-text-tertiary">Loading</p>
      ) : routines && routines.length === 0 && !adding ? (
        <p className="text-body-2-regular text-text-tertiary">No routines yet. Add one and {bot.name} runs it on schedule into this thread.</p>
      ) : (
        routines?.map((routine) => <RoutineRow key={routine.id} bot={bot} routine={routine} onChange={changed} />)
      )}
      {error && (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      )}
    </section>
  );
}
