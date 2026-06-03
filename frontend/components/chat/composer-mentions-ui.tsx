"use client";

import {
  RiArrowLeftLine,
  RiArrowRightSLine,
  RiChat3Line,
  RiCloseLine,
  RiErrorWarningLine,
  RiFileLine,
  RiFlashlightLine,
  RiFolder3Line,
  RiGitPullRequestLine,
  RiLoader4Line,
} from "@remixicon/react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import { backendFetch } from "@/lib/backend-fetch";
import { cx as cn } from "@/utils/cx";
import { relativeTime } from "@/utils/format";
import {
  detectMentionTrigger,
  fileMention,
  insertMentionToken,
  type Mention,
  type MentionKind,
  mentionKey,
  mentionsReducer,
  prMention,
  removeMentionToken,
  skillMention,
  threadMention,
} from "./composer-mentions";

export type { Mention } from "./composer-mentions";
// Re-export the submit-side helpers the composers need, so a composer wires the
// whole feature from this one module.
export { mentionsToRunResources } from "./composer-mentions";

// ---------------------------------------------------------------------------
// The "@" mention popover + chips, shared by the reply composer and the new-task
// composer (see composer-mentions.ts for the pure token/reference/reducer logic).
// Honest v1: a plain textarea, so a mention is a text token PLUS a removable chip;
// data is drilled category -> searchable list, matched to real backend endpoints
// (skills, run summaries, pulls, and the repo tree browse endpoint).
// ---------------------------------------------------------------------------

/** A skill the caller already has (new-task composer); else the hook fetches. */
export type MentionSkill = { id: string; name: string; tag?: string };

const CATEGORIES: {
  kind: MentionKind;
  label: string;
  description: string;
  icon: typeof RiFolder3Line;
}[] = [
  { kind: "file", label: "Files", description: "Files in the project's repositories", icon: RiFolder3Line },
  { kind: "pr", label: "Pull requests", description: "Open and recent pull requests", icon: RiGitPullRequestLine },
  { kind: "thread", label: "Threads", description: "Reference another thread", icon: RiChat3Line },
  { kind: "skill", label: "Skills", description: "Skills available to the agent", icon: RiFlashlightLine },
];

const CATEGORY_LABEL: Record<MentionKind, string> = {
  file: "Files",
  pr: "Pull requests",
  thread: "Threads",
  skill: "Skills",
};

type Resource<T> = { status: "idle" | "loading" | "ready" | "error"; items: T[] };
const IDLE: Resource<never> = { status: "idle", items: [] };

type ThreadItem = { id: string; title: string; meta: string };
type PullItem = { repo: string; number: number; title: string };
type RepoItem = { full_name: string; private: boolean; default_branch: string | null };
type TreeItem = { path: string; name: string; type: "file" | "dir" };

type MentionView =
  | { level: "root" }
  | { level: "list"; kind: "skill" | "thread" | "pr" }
  | { level: "files"; repo: string | null; revision: string | null; dir: string };

type MentionRow =
  | { type: "category"; kind: MentionKind; label: string; description: string }
  | { type: "skill"; id: string; name: string; tag?: string }
  | { type: "thread"; id: string; title: string; meta: string }
  | { type: "pr"; repo: string; number: number; title: string }
  | { type: "repo"; full_name: string; private: boolean }
  | { type: "dir"; path: string; name: string }
  | { type: "file"; path: string; name: string };

function firstLine(text: string): string {
  const line = (text ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim();
}

async function fetchThreads(): Promise<ThreadItem[]> {
  const res = await backendFetch("/api/runs?view=summary&limit=50");
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as {
    runs?: { id?: string; prompt?: string; created_at?: string | number; createdAt?: string | number }[];
  };
  const runs = Array.isArray(data.runs) ? data.runs : [];
  return runs
    .filter((r): r is { id: string; prompt?: string; created_at?: string | number; createdAt?: string | number } =>
      typeof r.id === "string",
    )
    .map((r) => ({
      id: r.id,
      title: firstLine(r.prompt ?? "") || "Untitled thread",
      meta: relativeTime(r.created_at ?? r.createdAt ?? null),
    }));
}

async function fetchPulls(): Promise<PullItem[]> {
  const res = await backendFetch("/api/pulls");
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as {
    pulls?: { repo?: string; number?: number; title?: string }[];
  };
  const pulls = Array.isArray(data.pulls) ? data.pulls : [];
  return pulls
    .filter((p): p is { repo: string; number: number; title?: string } =>
      typeof p.repo === "string" && typeof p.number === "number",
    )
    .map((p) => ({ repo: p.repo, number: p.number, title: p.title ?? "" }));
}

async function fetchRepos(): Promise<RepoItem[]> {
  const res = await backendFetch("/api/repos");
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as {
    repos?: { full_name?: string; private?: boolean; default_branch?: string }[];
  };
  const repos = Array.isArray(data.repos) ? data.repos : [];
  return repos
    .filter((r): r is { full_name: string; private?: boolean; default_branch?: string } =>
      typeof r.full_name === "string",
    )
    .map((r) => ({
      full_name: r.full_name,
      private: Boolean(r.private),
      default_branch: typeof r.default_branch === "string" ? r.default_branch : null,
    }));
}

export function repoTreeUrl(repo: string, revision: string | null, dir: string): string {
  const params = new URLSearchParams();
  if (revision) params.set("ref", revision);
  if (dir) params.set("path", dir);
  return `/api/repos/${repo}/tree${params.size ? `?${params.toString()}` : ""}`;
}

async function fetchTree(repo: string, revision: string | null, dir: string): Promise<TreeItem[]> {
  const res = await backendFetch(repoTreeUrl(repo, revision, dir));
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as { entries?: { path?: string; type?: string }[] };
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return entries
    .filter((e): e is { path: string; type?: string } => typeof e.path === "string")
    .map((e) => ({
      path: e.path,
      name: e.path.split("/").pop() ?? e.path,
      type: e.type === "dir" ? "dir" : "file",
    }));
}

/** Order the caller's already-selected repos first, then the rest. */
function orderRepos(repos: RepoItem[], selected: readonly string[] | undefined): RepoItem[] {
  if (!selected || selected.length === 0) return repos;
  const set = new Set(selected);
  return [...repos.filter((r) => set.has(r.full_name)), ...repos.filter((r) => !set.has(r.full_name))];
}

export type UseComposerMentions = {
  mentions: Mention[];
  open: boolean;
  onTextareaKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  clear: () => void;
  chips: ReactNode;
  popover: ReactNode;
};

/**
 * The composer "@" mention controller. Owns the popover view/highlight state, the
 * structured mention records, data fetching per drilled category, and keyboard
 * nav; returns ready-to-drop `chips` and `popover` nodes plus the textarea
 * handlers so each composer's wiring stays tiny.
 *
 * v1 note: the structured records (the chips) are EPHEMERAL - they are not
 * persisted with the composer draft. The inserted text tokens DO persist with the
 * draft (they live in the textarea value), so a reload still carries the reference
 * text into the prompt; only the removable-chip affordance and typed binding are
 * lost until the mention is re-picked.
 */
export function useComposerMentions(opts: {
  value: string;
  onValueChange: (v: string) => void;
  containerRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  skills?: readonly MentionSkill[];
  selectedRepos?: readonly string[];
  repoRevisions?: Readonly<Record<string, string | null>>;
  /** Popover opens above the composer ("top", reply) or below it ("bottom", new task). */
  placement?: "top" | "bottom";
}): UseComposerMentions {
  const { value, onValueChange, containerRef, enabled = true, skills, selectedRepos, repoRevisions } = opts;
  const placement = opts.placement ?? "top";

  const [mentions, dispatch] = useReducer(mentionsReducer, []);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [view, setView] = useState<MentionView>({ level: "root" });
  const [highlight, setHighlight] = useState(0);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);

  const [threads, setThreads] = useState<Resource<ThreadItem>>(IDLE);
  const [pulls, setPulls] = useState<Resource<PullItem>>(IDLE);
  const [repos, setRepos] = useState<Resource<RepoItem>>(IDLE);
  const [tree, setTree] = useState<Resource<TreeItem>>(IDLE);
  const [fetchedSkills, setFetchedSkills] = useState<Resource<MentionSkill>>(IDLE);

  const trigger = enabled ? detectMentionTrigger(value, caret) : null;
  const open = trigger !== null && !dismissed;
  const query = trigger?.query ?? "";

  // Typing (a value change) always re-arms the popover after an Escape dismiss,
  // and re-reads the caret from the DOM. The `select` event alone is not a
  // reliable per-keystroke caret signal across browsers, so this makes typing
  // "@" open the popover regardless (onTextareaSelect still covers arrow/click
  // caret moves that do not change the value).
  useEffect(() => {
    setDismissed(false);
    if (pendingCaret != null) return; // an insert owns the caret this cycle
    const ta = containerRef.current?.querySelector("textarea");
    if (ta && (typeof document === "undefined" || document.activeElement === ta)) {
      setCaret(ta.selectionStart ?? 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Apply a caret move after a token insert (once React has painted the new text).
  useLayoutEffect(() => {
    if (pendingCaret == null) return;
    const ta = containerRef.current?.querySelector("textarea");
    if (ta) {
      ta.focus();
      ta.setSelectionRange(pendingCaret, pendingCaret);
    }
    setPendingCaret(null);
  }, [pendingCaret, containerRef]);

  // Lazily load the data for whichever category/level is open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async <T,>(
      set: (r: Resource<T>) => void,
      fetcher: () => Promise<T[]>,
    ) => {
      set({ status: "loading", items: [] });
      try {
        const items = await fetcher();
        if (!cancelled) set({ status: "ready", items });
      } catch {
        if (!cancelled) set({ status: "error", items: [] });
      }
    };
    if (view.level === "list" && view.kind === "thread") void load(setThreads, fetchThreads);
    else if (view.level === "list" && view.kind === "pr") void load(setPulls, fetchPulls);
    else if (view.level === "list" && view.kind === "skill" && !skills)
      void load(setFetchedSkills, fetchSkillsPicker);
    else if (view.level === "files" && view.repo === null) void load(setRepos, fetchRepos);
    else if (view.level === "files" && view.repo !== null) {
      const repo = view.repo;
      const revision = view.revision;
      const dir = view.dir;
      void load(setTree, () => fetchTree(repo, revision, dir));
    }
    return () => {
      cancelled = true;
    };
  }, [open, view, skills]);

  const skillItems = skills ?? fetchedSkills.items;

  const { rows, status } = useMemo(
    () =>
      computeRows({
        view,
        query,
        skillItems,
        skillStatus: skills ? "ready" : fetchedSkills.status,
        threads,
        pulls,
        repos: { ...repos, items: orderRepos(repos.items, selectedRepos) },
        tree,
      }),
    [view, query, skillItems, skills, fetchedSkills.status, threads, pulls, repos, tree, selectedRepos],
  );

  const insertMention = useCallback(
    (m: Mention) => {
      if (!trigger) return;
      const next = insertMentionToken(value, trigger.start, caret, m.token);
      onValueChange(next.text);
      dispatch({ type: "add", mention: m });
      setView({ level: "root" });
      setHighlight(0);
      setCaret(next.caret);
      setPendingCaret(next.caret);
    },
    [trigger, value, caret, onValueChange],
  );

  const activate = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      if (row.type === "category") {
        setView(row.kind === "file" ? { level: "files", repo: null, revision: null, dir: "" } : { level: "list", kind: row.kind });
        setHighlight(0);
      } else if (row.type === "skill") insertMention(skillMention(row.id, row.name));
      else if (row.type === "thread") insertMention(threadMention(row.id, row.title));
      else if (row.type === "pr") insertMention(prMention(row.repo, row.number, row.title));
      else if (row.type === "repo") {
        const repo = repos.items.find((item) => item.full_name === row.full_name);
        setView({
          level: "files",
          repo: row.full_name,
          revision: repoRevisions?.[row.full_name] ?? repo?.default_branch ?? null,
          dir: "",
        });
        setHighlight(0);
      } else if (row.type === "dir" && view.level === "files") {
        setView({ ...view, dir: row.path });
        setHighlight(0);
      } else if (row.type === "file" && view.level === "files" && view.repo) {
        insertMention(fileMention(view.repo, row.path, view.revision));
      }
    },
    [rows, insertMention, view, repos.items, repoRevisions],
  );

  const goBack = useCallback(() => {
    setHighlight(0);
    // In a subdirectory, climb one level; at a repo root or a list, return to root.
    if (view.level === "files" && view.repo !== null && view.dir !== "") {
      const parentDir = view.dir.includes("/") ? view.dir.split("/").slice(0, -1).join("/") : "";
      setView({ ...view, dir: parentDir });
    } else {
      setView({ level: "root" });
    }
  }, [view]);

  const onTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
      const count = rows.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (count) setHighlight((h) => (h + 1) % count);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (count) setHighlight((h) => (h - 1 + count) % count);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (count) activate(Math.min(highlight, count - 1));
      }
    },
    [open, rows.length, highlight, activate],
  );

  const onTextareaSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setCaret(e.currentTarget.selectionStart ?? 0);
  }, []);

  const removeMention = useCallback(
    (m: Mention) => {
      dispatch({ type: "remove", key: mentionKey(m) });
      onValueChange(removeMentionToken(value, m.token));
    },
    [onValueChange, value],
  );

  const clear = useCallback(() => dispatch({ type: "clear" }), []);

  const chips = <MentionChips mentions={mentions} onRemove={removeMention} />;
  const popover = open ? (
    <MentionPopover
      view={view}
      rows={rows}
      status={status}
      query={query}
      highlight={highlight}
      placement={placement}
      onHover={setHighlight}
      onActivate={activate}
      onBack={goBack}
    />
  ) : null;

  return { mentions, open, onTextareaKeyDown, onTextareaSelect, clear, chips, popover };
}

async function fetchSkillsPicker(): Promise<MentionSkill[]> {
  const res = await backendFetch("/api/skills?view=picker&limit=2000");
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as {
    skills?: { id?: string; name?: string; tags?: string[] }[];
  };
  const list = Array.isArray(data.skills) ? data.skills : [];
  return list
    .filter((s): s is { id: string; name: string; tags?: string[] } =>
      typeof s.id === "string" && typeof s.name === "string",
    )
    .map((s) => ({ id: s.id, name: s.name, tag: s.tags?.[0] }));
}

function includesQuery(haystack: string, q: string): boolean {
  return haystack.toLowerCase().includes(q.toLowerCase());
}

const ROW_CAP = 50;

function computeRows(input: {
  view: MentionView;
  query: string;
  skillItems: readonly MentionSkill[];
  skillStatus: Resource<unknown>["status"];
  threads: Resource<ThreadItem>;
  pulls: Resource<PullItem>;
  repos: Resource<RepoItem>;
  tree: Resource<TreeItem>;
}): { rows: MentionRow[]; status: Resource<unknown>["status"] } {
  const { view, query } = input;
  if (view.level === "root") {
    return {
      rows: CATEGORIES.map((c) => ({
        type: "category" as const,
        kind: c.kind,
        label: c.label,
        description: c.description,
      })),
      status: "ready",
    };
  }
  if (view.level === "list" && view.kind === "skill") {
    const rows = input.skillItems
      .filter((s) => includesQuery(s.name, query) || (s.tag ? includesQuery(s.tag, query) : false))
      .slice(0, ROW_CAP)
      .map((s) => ({ type: "skill" as const, id: s.id, name: s.name, tag: s.tag }));
    return { rows, status: input.skillStatus };
  }
  if (view.level === "list" && view.kind === "thread") {
    const rows = input.threads.items
      .filter((t) => includesQuery(t.title, query))
      .slice(0, ROW_CAP)
      .map((t) => ({ type: "thread" as const, id: t.id, title: t.title, meta: t.meta }));
    return { rows, status: input.threads.status };
  }
  if (view.level === "list" && view.kind === "pr") {
    const rows = input.pulls.items
      .filter((p) => includesQuery(`${p.repo}#${p.number} ${p.title}`, query))
      .slice(0, ROW_CAP)
      .map((p) => ({ type: "pr" as const, repo: p.repo, number: p.number, title: p.title }));
    return { rows, status: input.pulls.status };
  }
  // files: repo picker, then directory-by-directory browse
  if (view.level === "files" && view.repo === null) {
    const rows = input.repos.items
      .filter((r) => includesQuery(r.full_name, query))
      .slice(0, ROW_CAP)
      .map((r) => ({ type: "repo" as const, full_name: r.full_name, private: r.private }));
    return { rows, status: input.repos.status };
  }
  const rows = input.tree.items
    .filter((e) => includesQuery(e.name, query))
    .slice(0, ROW_CAP)
    .map((e) =>
      e.type === "dir"
        ? ({ type: "dir", path: e.path, name: e.name } as const)
        : ({ type: "file", path: e.path, name: e.name } as const),
    );
  return { rows, status: input.tree.status };
}

// ---------------------------------------------------------------------------
// Chips (removable, above the composer) - mirrors the RunUploadChips row.
// ---------------------------------------------------------------------------

function chipIcon(kind: MentionKind) {
  switch (kind) {
    case "skill":
      return RiFlashlightLine;
    case "thread":
      return RiChat3Line;
    case "pr":
      return RiGitPullRequestLine;
    case "file":
      return RiFileLine;
  }
}

function chipLabel(m: Mention): string {
  switch (m.kind) {
    case "skill":
      return m.name;
    case "thread":
      return `thread/${m.shortId}`;
    case "pr":
      return `${m.repo}#${m.number}`;
    case "file":
      return m.path.split("/").pop() ?? m.path;
  }
}

function MentionChips({
  mentions,
  onRemove,
}: {
  mentions: readonly Mention[];
  onRemove: (m: Mention) => void;
}) {
  if (mentions.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 px-1 pb-1.5" aria-label="Referenced context">
      {mentions.map((m) => {
        const Icon = chipIcon(m.kind);
        return (
          <li
            key={mentionKey(m)}
            className="border-border-button-default bg-background-secondary-default text-text-secondary inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-caption-1-medium"
          >
            <Icon className="size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <span className="max-w-52 truncate" title={m.token}>
              {chipLabel(m)}
            </span>
            <button
              type="button"
              aria-label={`Remove ${chipLabel(m)}`}
              onClick={() => onRemove(m)}
              className="hover:text-text-primary rounded"
            >
              <RiCloseLine className="size-3.5" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Popover (BoardUI dropdown/command styling, mirrors SlashCommandPopover).
// ---------------------------------------------------------------------------

function rowIcon(row: MentionRow) {
  switch (row.type) {
    case "category":
      return CATEGORIES.find((c) => c.kind === row.kind)?.icon ?? RiFileLine;
    case "skill":
      return RiFlashlightLine;
    case "thread":
      return RiChat3Line;
    case "pr":
      return RiGitPullRequestLine;
    case "repo":
    case "dir":
      return RiFolder3Line;
    case "file":
      return RiFileLine;
  }
}

function rowPrimary(row: MentionRow): string {
  switch (row.type) {
    case "category":
      return row.label;
    case "skill":
      return row.name;
    case "thread":
      return row.title;
    case "pr":
      return `${row.repo}#${row.number}`;
    case "repo":
      return row.full_name;
    case "dir":
    case "file":
      return row.name;
  }
}

function rowSecondary(row: MentionRow): string | undefined {
  switch (row.type) {
    case "category":
      return row.description;
    case "skill":
      return row.tag;
    case "thread":
      return row.meta;
    case "pr":
      return row.title || undefined;
    case "repo":
      return row.private ? "Private" : "Public";
    default:
      return undefined;
  }
}

const EMPTY_TEXT: Record<string, string> = {
  skill: "No matching skills.",
  thread: "No matching threads.",
  pr: "No matching pull requests.",
  files: "No matching files.",
};

function statusText(view: MentionView, status: Resource<unknown>["status"]): string | null {
  if (status === "loading") return "Loading...";
  if (status === "error") return "Couldn't load - keep typing to send as text.";
  const key = view.level === "files" ? "files" : view.level === "list" ? view.kind : "";
  return EMPTY_TEXT[key] ?? "No results.";
}

function MentionPopover({
  view,
  rows,
  status,
  query,
  highlight,
  placement,
  onHover,
  onActivate,
  onBack,
}: {
  view: MentionView;
  rows: MentionRow[];
  status: Resource<unknown>["status"];
  query: string;
  highlight: number;
  placement: "top" | "bottom";
  onHover: (index: number) => void;
  onActivate: (index: number) => void;
  onBack: () => void;
}) {
  const atRoot = view.level === "root";
  const header =
    view.level === "root"
      ? "Add context"
      : view.level === "list"
        ? CATEGORY_LABEL[view.kind]
        : view.repo === null
          ? "Select a repository"
          : `${view.repo}${view.dir ? `:${view.dir}` : ""}`;
  const showStatusRow = rows.length === 0;

  return (
    <div
      className={cn(
        "absolute left-0 z-30 w-full",
        placement === "top" ? "bottom-full mb-2" : "top-full mt-2",
      )}
    >
      <div className="border-border-button-default bg-background-primary-default shadow-dropdown w-full rounded-2xl border p-2">
        <div className="flex items-center gap-1.5 px-1 pb-1 pt-0.5">
          {!atRoot && (
            <button
              type="button"
              aria-label="Back"
              // mousedown (not click) so the textarea keeps focus.
              onMouseDown={(e) => {
                e.preventDefault();
                onBack();
              }}
              className="text-text-secondary hover:bg-background-primary-hover -ml-0.5 flex size-5 items-center justify-center rounded"
            >
              <RiArrowLeftLine className="size-4" aria-hidden />
            </button>
          )}
          <p className="text-mono-label text-text-tertiary min-w-0 flex-1 truncate" id="mention-label">
            {header}
          </p>
          {query && (
            <span className="text-caption-1-regular text-text-tertiary shrink-0 font-mono">@{query}</span>
          )}
        </div>
        <div className="max-h-72 overflow-y-auto" role="listbox" aria-labelledby="mention-label">
          {showStatusRow ? (
            <p
              className={cn(
                "px-2 py-2 text-caption-1-regular",
                status === "error" ? "text-red-500" : "text-text-tertiary",
              )}
              role={status === "error" ? "alert" : "status"}
            >
              {status === "error" ? (
                <span className="flex items-center gap-1.5">
                  <RiErrorWarningLine className="size-3.5 shrink-0" aria-hidden />
                  {statusText(view, status)}
                </span>
              ) : status === "loading" ? (
                <span className="flex items-center gap-1.5">
                  <RiLoader4Line className="size-3.5 shrink-0 animate-spin" aria-hidden />
                  {statusText(view, status)}
                </span>
              ) : (
                statusText(view, status)
              )}
            </p>
          ) : (
            rows.map((row, i) => {
              const Icon = rowIcon(row);
              const secondary = rowSecondary(row);
              const drills = row.type === "category" || row.type === "repo" || row.type === "dir";
              return (
                <button
                  key={rowKey(row, i)}
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onActivate(i);
                  }}
                  onMouseEnter={() => onHover(i)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors",
                    i === highlight ? "bg-background-secondary-default" : "hover:bg-background-primary-hover",
                  )}
                >
                  <Icon className="text-text-secondary size-4 shrink-0" aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-body-2-medium text-text-primary truncate">{rowPrimary(row)}</span>
                    {secondary && (
                      <span className="text-caption-1-regular text-text-tertiary truncate">{secondary}</span>
                    )}
                  </span>
                  {drills && (
                    <RiArrowRightSLine className="text-foreground-icon-tertiary size-4 shrink-0" aria-hidden />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function rowKey(row: MentionRow, index: number): string {
  switch (row.type) {
    case "category":
      return `cat-${row.kind}`;
    case "skill":
      return `skill-${row.id}`;
    case "thread":
      return `thread-${row.id}`;
    case "pr":
      return `pr-${row.repo}#${row.number}`;
    case "repo":
      return `repo-${row.full_name}`;
    default:
      return `path-${row.path}-${index}`;
  }
}
