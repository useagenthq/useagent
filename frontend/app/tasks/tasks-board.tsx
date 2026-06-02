"use client";

import { RiAddLine, RiDeleteBinLine } from "@remixicon/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { Chip } from "@/components/base/badges/chip";
import { InputBase, TextField } from "@/components/base/input/input";
import {
  createTask,
  deleteTask,
  fetchTasks,
  updateTask,
} from "./tasks-api";
import {
  ALL_PROJECTS,
  TASK_STATUSES,
  groupTasksByColumn,
  initialProjectFilter,
  projectOptions,
  type Task,
  type TaskStatus,
} from "./tasks-data";

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
  archived: "Archived",
};

type ChipColor = "neutral" | "blue" | "lime" | "gray";
const STATUS_CHIP: Record<TaskStatus, ChipColor> = {
  todo: "neutral",
  in_progress: "blue",
  done: "lime",
  archived: "gray",
};

const selectClass =
  "h-8 rounded-lg border border-border-button-default bg-background-primary-default px-2 text-body-medium text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring";

export function TasksBoard({
  initial = [],
  initialRepos = [],
  initialError = false,
  initialProject,
}: {
  initial?: Task[];
  initialRepos?: string[];
  initialError?: boolean;
  /** The `?project=` deep-link, read server-side and used to preselect the
   *  filter so the SSR board already shows that project (no filter flash). */
  initialProject?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [tasks, setTasks] = useState<Task[]>(initial);
  const [repos] = useState<string[]>(initialRepos);
  const [project, setProject] = useState<string>(() => initialProjectFilter(initialProject));
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const scoped = project === ALL_PROJECTS ? undefined : project;

  // The project filter is mirrored into the URL so a board view is shareable and
  // back/forward correct. Selecting a project writes `?project=` (replace, no
  // history spam); browser navigation writes it back into state.
  const selectProject = useCallback(
    (next: string) => {
      setProject(next);
      const query = next === ALL_PROJECTS ? "" : `?project=${encodeURIComponent(next)}`;
      router.replace(`${pathname}${query}`, { scroll: false });
    },
    [pathname, router],
  );

  const projectParam = searchParams?.get("project") ?? null;
  const firstParamSync = useRef(true);
  useEffect(() => {
    // Follow back/forward navigation. The first run matches the SSR seed, so
    // skip it - otherwise it would clobber `initialProject` on mount.
    if (firstParamSync.current) {
      firstParamSync.current = false;
      return;
    }
    setProject(initialProjectFilter(projectParam));
  }, [projectParam]);

  const refetch = useCallback(async (forProject?: string) => {
    setLoading(true);
    try {
      const fresh = await fetchTasks(forProject);
      setTasks(fresh);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Refetch when the project filter changes. The SSR seed already covers the
  // initial "all projects" view, so skip the first render for it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (!mounted) {
      setMounted(true);
      return;
    }
    void refetch(scoped);
  }, [project]);

  const columns = useMemo(() => groupTasksByColumn(tasks), [tasks]);
  // Keep the active scope selectable even when it is deep-linked to a project
  // that has no tasks yet and is absent from the repo list - otherwise the
  // controlled select would render with no matching option.
  const options = useMemo(
    () => projectOptions(tasks, scoped ? [...repos, scoped] : repos),
    [tasks, repos, scoped],
  );

  const onCreate = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    setBusyId("__create__");
    try {
      const created = await createTask({
        title,
        project_key: scoped ?? null,
      });
      setNewTitle("");
      // Only show it here when it belongs in the current filter.
      if (!scoped || created.project_key === scoped) {
        setTasks((prev) => [created, ...prev]);
      }
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusyId(null);
    }
  }, [newTitle, scoped]);

  const onMove = useCallback(async (task: Task, status: TaskStatus) => {
    if (status === task.status) return;
    setBusyId(task.id);
    try {
      const updated = await updateTask(task.id, { status });
      setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusyId(null);
    }
  }, []);

  const onDelete = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await deleteTask(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <div className="flex flex-col gap-5">
      {/* Controls: project filter + create affordance. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-body-medium text-text-secondary">
          Project
          <select
            aria-label="Filter by project"
            className={selectClass}
            value={project}
            onChange={(e) => selectProject(e.target.value)}
          >
            <option value={ALL_PROJECTS}>All projects</option>
            {options.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate();
          }}
        >
          <TextField
            aria-label="New task title"
            className="w-64"
            value={newTitle}
            onChange={setNewTitle}
          >
            <InputBase placeholder="Add a task..." autoComplete="off" />
          </TextField>
          <Button
            type="submit"
            size="small"
            leadingIcon={RiAddLine}
            disabled={busyId === "__create__" || !newTitle.trim()}
          >
            Add
          </Button>
        </form>
      </div>

      {error ? (
        <p className="text-body-regular text-text-error-primary">
          Could not reach the task service. Retry in a moment.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {columns.map((col) => (
          <section
            key={col.status}
            className="flex flex-col gap-3 rounded-xl border border-border-button-default bg-background-secondary-default p-3"
          >
            <header className="flex items-center justify-between px-1">
              <h2 className="text-body-medium text-text-primary">{col.label}</h2>
              <Chip variant="caption" color={STATUS_CHIP[col.status]}>
                {col.tasks.length}
              </Chip>
            </header>

            <div className="flex flex-col gap-2">
              {col.tasks.length === 0 ? (
                <p className="px-1 py-6 text-center text-caption-1-regular text-text-tertiary">
                  {loading ? "Loading..." : "No tasks"}
                </p>
              ) : (
                col.tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    showProject={project === ALL_PROJECTS}
                    busy={busyId === task.id}
                    onMove={onMove}
                    onDelete={onDelete}
                  />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  showProject,
  busy,
  onMove,
  onDelete,
}: {
  task: Task;
  showProject: boolean;
  busy: boolean;
  onMove: (task: Task, status: TaskStatus) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border-button-default bg-background-primary-default p-3 shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-body-medium text-text-primary">{task.title}</p>
        <Button
          size="xs"
          variant="ghost"
          iconOnly
          leadingIcon={RiDeleteBinLine}
          aria-label="Delete task"
          disabled={busy}
          onClick={() => onDelete(task.id)}
        />
      </div>

      {task.body ? (
        <p className="line-clamp-3 text-caption-1-regular text-text-secondary">{task.body}</p>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        {showProject && task.project_key ? (
          <Chip variant="caption" color="soft" className="max-w-[60%] truncate">
            {task.project_key}
          </Chip>
        ) : (
          <span />
        )}
        <select
          aria-label="Task status"
          className={selectClass}
          value={task.status}
          disabled={busy}
          onChange={(e) => onMove(task, e.target.value as TaskStatus)}
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
    </article>
  );
}
