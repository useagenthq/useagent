"use client";

import { useEffect, useMemo, useState } from "react";
import {
  RepoMultiPicker,
  type RepoItem,
} from "@/app/agent/new/repo-multi-picker";
import { backendFetch } from "@/lib/backend-fetch";

interface RepositoryResponse {
  readonly full_name?: unknown;
  readonly name?: unknown;
  readonly private?: unknown;
  readonly default_branch?: unknown;
}

function repositoryItem(value: RepositoryResponse): RepoItem | null {
  if (typeof value.full_name !== "string" || !value.full_name) return null;
  return {
    full_name: value.full_name,
    name:
      typeof value.name === "string" && value.name
        ? value.name
        : (value.full_name.split("/").at(-1) ?? value.full_name),
    private: value.private === true,
    default_branch:
      typeof value.default_branch === "string" && value.default_branch
        ? value.default_branch
        : "",
  };
}

export function BotRepositories({
  value,
  onChange,
  locked = false,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  locked?: boolean;
}) {
  const [available, setAvailable] = useState<RepoItem[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (locked) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await backendFetch("/api/repos");
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { repos?: RepositoryResponse[] };
        const repos = Array.isArray(body.repos)
          ? body.repos.map(repositoryItem).filter((item): item is RepoItem => item !== null)
          : [];
        if (!cancelled) setAvailable(repos);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locked]);

  const repos = useMemo(() => {
    const byName = new Map(available.map((repo) => [repo.full_name, repo]));
    for (const fullName of value) {
      if (!byName.has(fullName)) {
        byName.set(fullName, {
          full_name: fullName,
          name: fullName.split("/").at(-1) ?? fullName,
          default_branch: "",
        });
      }
    }
    return [...byName.values()];
  }, [available, value]);

  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-body-2-medium text-text-primary">Repositories</h2>
      {locked ? (
        value.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Bot repositories">
            {value.map((repo) => (
              <li
                key={repo}
                className="max-w-full truncate rounded-full border border-border-button-default bg-background-secondary-default px-2.5 py-1 text-caption-1-medium text-text-secondary"
                title={repo}
              >
                {repo}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body-2-regular text-text-tertiary">No repositories</p>
        )
      ) : (
        <RepoMultiPicker
          repos={repos}
          value={value}
          onChange={onChange}
          emptyLabel="Choose repositories"
          triggerClassName="w-full justify-start rounded-xl border border-border-button-default px-3 py-2"
        />
      )}
      <p className="text-caption-1-regular text-text-tertiary">
        {locked
          ? "Home and routine repositories are fixed after the bot's first message. Handoffs inherit the parent thread's repositories."
          : "Used for the bot's home thread and routines. Handoffs inherit the parent thread's repositories."}
      </p>
      {error ? (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          Couldn't load repositories. Try again later.
        </p>
      ) : null}
    </section>
  );
}
