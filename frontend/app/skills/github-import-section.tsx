"use client";

import { useEffect, useMemo, useState } from "react";
import { RiGithubLine } from "@remixicon/react";

import { Chip, type ChipProps } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { SearchablePicker, type PickerGroup } from "@/app/agent/new/searchable-picker";
import { backendFetch } from "@/lib/backend-fetch";
import {
  scanSkillImports,
  importSkillPaths,
  type SkillImportOutcome,
  type SkillScanResult,
} from "./skills-api";

/**
 * "Import from GitHub" - the browse half of the page, wired to the real
 * backend flow (GET /api/skills/import/scan + POST /api/skills/import): pick
 * one of the org's repos, scan it for SKILL.md files, select and import. The
 * same source-keyed upsert powers per-skill resync, so re-importing an
 * already-imported path is safe (unchanged content is a no-op). Everything
 * rendered is real backend data - no marketplace, no invented install counts.
 */

interface RepoRef {
  full_name: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const OUTCOME_CHIP: Record<
  SkillImportOutcome["action"],
  { label: string; color: NonNullable<ChipProps["color"]> }
> = {
  created: { label: "Imported", color: "lime" },
  updated: { label: "Updated", color: "cyan" },
  unchanged: { label: "Unchanged", color: "soft" },
  protected: { label: "Protected", color: "yellow" },
  skipped: { label: "Skipped", color: "rose" },
};

export function GithubImportSection({
  onImported,
}: {
  /** The import wrote real skills - refetch the library above. */
  onImported: () => void | Promise<void>;
}) {
  // null = still loading; [] = none available (GitHub unconfigured or empty).
  const [repos, setRepos] = useState<RepoRef[] | null>(null);
  const [repo, setRepo] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<SkillScanResult | null>(null);
  const [scanError, setScanError] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, SkillImportOutcome>>({});

  // The org's real repos (GET /api/repos - the GitHub credential stays
  // server-side). Empty when unconfigured, so the section states that honestly.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await backendFetch("/api/repos");
        if (!res.ok) {
          if (!cancelled) setRepos([]);
          return;
        }
        const data = (await res.json()) as { repos?: { full_name?: string }[] };
        if (cancelled) return;
        setRepos(
          (data.repos ?? [])
            .filter((r): r is { full_name: string } => typeof r.full_name === "string")
            .map((r) => ({ full_name: r.full_name })),
        );
      } catch {
        if (!cancelled) setRepos([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const repoGroups: PickerGroup[] = useMemo(
    () => [
      {
        options: (repos ?? []).map((r) => ({
          value: r.full_name,
          label: r.full_name,
          icon: RiGithubLine,
        })),
      },
    ],
    [repos],
  );

  const onPickRepo = (next: string) => {
    setRepo(next);
    setScan(null);
    setScanError(false);
    setSelected(new Set());
    setOutcomes({});
    setImportError(false);
  };

  const onScan = async () => {
    if (!repo) return;
    setScanning(true);
    setScanError(false);
    setScan(null);
    setOutcomes({});
    setImportError(false);
    try {
      const result = await scanSkillImports(repo);
      setScan(result);
      // Pre-select what is new; already-imported paths stay opt-in (re-import
      // is a resync and unchanged content is a no-op).
      setSelected(
        new Set(result.candidates.filter((c) => !c.alreadyImported).map((c) => c.path)),
      );
    } catch {
      setScanError(true);
    } finally {
      setScanning(false);
    }
  };

  const toggle = (path: string, next: boolean) => {
    setSelected((prev) => {
      const set = new Set(prev);
      if (next) set.add(path);
      else set.delete(path);
      return set;
    });
  };

  const onImport = async () => {
    if (!repo || selected.size === 0) return;
    setImporting(true);
    setImportError(false);
    try {
      const { results } = await importSkillPaths(repo, [...selected]);
      const byPath: Record<string, SkillImportOutcome> = {};
      for (const outcome of results) byPath[outcome.path] = outcome;
      setOutcomes(byPath);
      // Reflect the new reality in the scan list without a rescan.
      setScan((prev) =>
        prev
          ? {
              ...prev,
              candidates: prev.candidates.map((c) =>
                byPath[c.path] && byPath[c.path].action !== "skipped"
                  ? { ...c, alreadyImported: true }
                  : c,
              ),
            }
          : prev,
      );
      setSelected(new Set());
      if (results.some((r) => r.action === "created" || r.action === "updated")) {
        await onImported();
      }
    } catch {
      setImportError(true);
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="mt-12">
      <h2 className="text-body-medium text-text-primary">Import from GitHub</h2>
      <p className="mt-1 text-caption-1-regular text-text-tertiary">
        Scan a repository for .claude/skills SKILL.md files and import them as
        org skills. Re-importing an existing skill resyncs it.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <SearchablePicker
          ariaLabel="Repository to scan"
          triggerLabel="Choose a repository"
          searchPlaceholder="Search repositories..."
          groups={repoGroups}
          value={repo}
          onChange={onPickRepo}
          triggerClassName="rounded-2lg border border-border-button-default bg-background-primary-default px-2.5 py-1.5 shadow-xs"
        />
        <Button
          variant="secondary"
          size="small"
          disabled={!repo || scanning}
          onClick={onScan}
        >
          {scanning ? "Scanning..." : "Scan repository"}
        </Button>
      </div>

      {repos !== null && repos.length === 0 && (
        <p className="mt-3 text-caption-1-regular text-text-tertiary">
          No repositories are available to this organization.
        </p>
      )}

      {scanError && (
        <p className="mt-3 text-caption-1-regular text-text-error-primary">
          Could not scan {repo}. Check the backend and try again.
        </p>
      )}

      {scan && scan.candidates.length === 0 && (
        <p className="mt-3 text-caption-1-regular text-text-tertiary">
          No SKILL.md files found in {scan.repo}.
        </p>
      )}

      {scan && scan.candidates.length > 0 && (
        <div className="mt-4">
          <ul className="divide-y divide-separator-border overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-xs">
            {scan.candidates.map((candidate) => {
              const outcome = outcomes[candidate.path];
              return (
                <li key={candidate.path} className="flex items-center gap-3 px-4 py-3">
                  <Checkbox
                    aria-label={`Import ${candidate.name}`}
                    isSelected={selected.has(candidate.path)}
                    isDisabled={importing}
                    onChange={(next) => toggle(candidate.path, next)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body-medium text-text-primary">
                      {candidate.name}
                    </p>
                    <p className="mt-0.5 truncate text-caption-1-regular text-text-tertiary">
                      {candidate.path} · {formatBytes(candidate.sizeBytes)}
                    </p>
                  </div>
                  {outcome ? (
                    <Chip variant="caption" color={OUTCOME_CHIP[outcome.action].color}>
                      {outcome.action === "skipped" && outcome.reason === "too_large"
                        ? "Too large"
                        : outcome.action === "skipped" && outcome.reason === "not_found"
                          ? "Not found"
                          : OUTCOME_CHIP[outcome.action].label}
                    </Chip>
                  ) : candidate.alreadyImported ? (
                    <Chip variant="caption" color="soft">
                      Imported
                    </Chip>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {(scan.skipped.length > 0 || scan.truncated) && (
            <p className="mt-2 text-caption-1-regular text-text-tertiary">
              {scan.skipped.length > 0 &&
                `${scan.skipped.length} ${scan.skipped.length === 1 ? "file" : "files"} skipped for exceeding the size cap.`}
              {scan.skipped.length > 0 && scan.truncated ? " " : ""}
              {scan.truncated && "The repository listing was truncated; this list may be incomplete."}
            </p>
          )}

          <div className="mt-3 flex items-center gap-3">
            <Button
              variant="primary"
              size="small"
              disabled={selected.size === 0 || importing}
              onClick={onImport}
            >
              {importing
                ? "Importing..."
                : `Import selected${selected.size > 0 ? ` (${selected.size})` : ""}`}
            </Button>
            {importError && (
              <p className="text-caption-1-regular text-text-error-primary">
                Import failed. Check the backend and try again.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
