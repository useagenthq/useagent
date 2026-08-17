"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/chat/ChangedFilesTree.tsx (ChangedFilesCard +
// ChangedFilesTree: the per-turn "N changed files +a -d" card with a compact
// scope preview and the directory-compacted file tree).
//
// Port notes:
// - lucide-react icons -> @remixicon/react (ChevronRight -> RiArrowRightSLine,
//   ChevronsUpDown/DownUp -> RiExpandUpDownLine/RiContractUpDownLine, Folder ->
//   RiFolderOpenLine/RiFolderLine, FileDiff -> RiFileList2Line). PierreEntryIcon
//   (ext-aware file glyphs) -> a plain RiFile3Line; no theme prop needed.
// - T3 shadcn tokens -> AlignUI semantic (secondary/bg-secondary -> bg-bg-weak-50,
//   muted-foreground -> text-text-sub-600/soft-400, accent hover -> bg-bg-soft-200,
//   border -> stroke-soft-200). The dark: color-mix sticky header is dropped;
//   the sticky header reuses the card surface.
// - Upstream is store-controlled (expanded/allDirectoriesExpanded from
//   uiStateStore, turnId-keyed onOpenTurnDiff). This port owns both flags
//   locally (WorkedForFold pattern) and the diff affordances collapse to ONE
//   optional `onOpenFile?(path?)` callback; when absent, the Open-diff button
//   hides and file rows render inert.

import {
  RiArrowRightSLine,
  RiContractUpDownLine,
  RiExpandUpDownLine,
  RiFile3Line,
  RiFileList2Line,
  RiFolderLine,
  RiFolderOpenLine,
} from "@remixicon/react";
import { memo, useCallback, useMemo, useState } from "react";
import * as Tooltip from "@/components/ui/tooltip";
import { cn } from "@/utils/cn";
import {
  buildTurnDiffTree,
  changedFileName,
  selectChangedFilePreview,
  summarizeChangedFileScopes,
  summarizeTurnDiffStats,
  type ChangedFile,
  type TurnDiffTreeNode,
} from "./changed-files";
import { hasNonZeroStat, DiffStatLabel } from "./diff-stat-label";

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};

/**
 * A settled turn's aggregated changed files: "N changed files +a -d" header,
 * expandable to the directory-compacted tree, with the upstream compact scope
 * preview while collapsed. Purely presentational; feed it entries from
 * changedFilesFromTimeline in ./adapter.ts.
 */
export const ChangedFilesCard = memo(function ChangedFilesCard(props: {
  files: ReadonlyArray<ChangedFile>;
  defaultExpanded?: boolean;
  showCompactPreview?: boolean;
  onOpenFile?: (path?: string) => void;
}) {
  const { files, defaultExpanded = false, showCompactPreview = true, onOpenFile } = props;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [allDirectoriesExpanded, setAllDirectoriesExpanded] = useState(true);
  const summaryStat = useMemo(() => summarizeTurnDiffStats(files), [files]);
  const scopeSummary = useMemo(() => summarizeChangedFileScopes(files), [files]);
  const previewFiles = useMemo(() => selectChangedFilePreview(files), [files]);
  const compactPreviewVisible = showCompactPreview && !expanded;

  if (files.length === 0) return null;

  return (
    <div
      data-session-ui="changed-files-card"
      className="mt-4 rounded-10 border border-stroke-soft-200 bg-bg-weak-50 p-2"
      data-changed-files-state={
        expanded ? "expanded" : compactPreviewVisible ? "preview" : "collapsed"
      }
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 rounded-lg px-1",
          expanded && "sticky top-2 z-10 mb-2 bg-bg-weak-50",
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          className="group flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-bg-soft-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-base"
          onClick={() => setExpanded((v) => !v)}
        >
          <RiArrowRightSLine
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-text-soft-400 transition-transform",
              expanded && "rotate-90",
            )}
          />
          <span className="flex min-w-0 items-center gap-1 whitespace-nowrap text-[12px] font-medium leading-4 text-text-strong-950">
            <span>
              {files.length} changed file{files.length === 1 ? "" : "s"}
            </span>
            {hasNonZeroStat(summaryStat) && (
              <DiffStatLabel
                additions={summaryStat.additions}
                className="text-[12px] leading-4"
                deletions={summaryStat.deletions}
                layout="inline"
              />
            )}
          </span>
          <span className="ml-1 hidden truncate text-[11px] text-text-soft-400 group-hover:text-text-sub-600 sm:inline">
            {expanded ? "Hide files" : "Show files"}
          </span>
        </button>
        <div className="flex items-center gap-1.5">
          {expanded ? (
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  className="flex size-[22px] cursor-pointer items-center justify-center rounded-md border border-stroke-soft-200 text-text-sub-600 transition-colors hover:bg-bg-soft-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-base"
                  aria-label={
                    allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                  }
                  onClick={() => setAllDirectoriesExpanded((v) => !v)}
                >
                  {allDirectoriesExpanded ? (
                    <RiContractUpDownLine className="size-3" aria-hidden />
                  ) : (
                    <RiExpandUpDownLine className="size-3" aria-hidden />
                  )}
                </button>
              </Tooltip.Trigger>
              <Tooltip.Content size="xsmall">
                {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
              </Tooltip.Content>
            </Tooltip.Root>
          ) : null}
          {onOpenFile ? (
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  className="flex h-[22px] cursor-pointer items-center gap-1 rounded-md border border-stroke-soft-200 px-1.5 text-[11px] font-medium text-text-sub-600 transition-colors hover:bg-bg-soft-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-base"
                  aria-label="Open diff"
                  onClick={() => onOpenFile(files[0]?.path)}
                >
                  <RiFileList2Line className="size-3" aria-hidden />
                  <span className="hidden sm:inline">Open diff</span>
                </button>
              </Tooltip.Trigger>
              <Tooltip.Content size="xsmall">Open the full diff</Tooltip.Content>
            </Tooltip.Root>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <ChangedFilesTree
          files={files}
          allDirectoriesExpanded={allDirectoriesExpanded}
          onOpenFile={onOpenFile}
        />
      ) : compactPreviewVisible ? (
        <div className="px-2 pb-1.5 pt-1">
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-text-sub-600">
            {scopeSummary.map((scope, index) => (
              <span key={scope.label} className="inline-flex items-center gap-1">
                {index > 0 ? <span aria-hidden="true">·</span> : null}
                <span className="font-mono text-text-strong-950/75">{scope.label}</span>
                <span>
                  {scope.fileCount} file{scope.fileCount === 1 ? "" : "s"}
                </span>
              </span>
            ))}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {previewFiles.map((file) => (
              <button
                key={file.path}
                type="button"
                title={file.path}
                className="inline-flex max-w-48 cursor-pointer items-center gap-1 rounded-md border border-stroke-soft-200 bg-bg-white-0/45 px-1.5 py-1 font-mono text-[10px] text-text-sub-600 transition-colors hover:bg-bg-soft-200 hover:text-text-strong-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-base"
                onClick={() => onOpenFile?.(file.path)}
              >
                <RiFile3Line className="size-3 shrink-0 text-text-soft-400" aria-hidden />
                <span className="truncate">{changedFileName(file.path)}</span>
              </button>
            ))}
            <button
              type="button"
              className="cursor-pointer rounded-md px-1.5 py-1 text-[11px] font-medium text-text-sub-600 transition-colors hover:bg-bg-soft-200 hover:text-text-strong-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-base"
              onClick={() => setExpanded(true)}
            >
              Show all {files.length} files
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  files: ReadonlyArray<ChangedFile>;
  allDirectoriesExpanded?: boolean;
  onOpenFile?: (path?: string) => void;
}) {
  const { files, allDirectoriesExpanded = true, onOpenFile } = props;
  const treeNodes = useMemo(() => buildTurnDiffTree(files), [files]);
  const directoryPathsKey = useMemo(
    () => collectDirectoryPaths(treeNodes).join("\u0000"),
    [treeNodes],
  );
  const hasDirectoryNodes = directoryPathsKey.length > 0;
  const expansionStateKey = `${allDirectoriesExpanded ? "expanded" : "collapsed"}\u0000${directoryPathsKey}`;
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string;
    overrides: Record<string, boolean>;
  }>(() => ({
    key: expansionStateKey,
    overrides: {},
  }));
  const expandedDirectories =
    directoryExpansionState.key === expansionStateKey
      ? directoryExpansionState.overrides
      : EMPTY_DIRECTORY_OVERRIDES;

  const toggleDirectory = useCallback(
    (pathValue: string) => {
      setDirectoryExpansionState((current) => {
        const nextOverrides = current.key === expansionStateKey ? current.overrides : {};
        return {
          key: expansionStateKey,
          overrides: {
            ...nextOverrides,
            [pathValue]: !(nextOverrides[pathValue] ?? allDirectoriesExpanded),
          },
        };
      });
    },
    [allDirectoriesExpanded, expansionStateKey],
  );

  const renderTreeNode = (node: TurnDiffTreeNode, depth: number) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded = expandedDirectories[node.path] ?? allDirectoriesExpanded;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            className="group flex w-full cursor-pointer items-center gap-1.5 rounded-lg py-1 pr-3 text-left transition-colors hover:bg-bg-soft-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-base"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path)}
          >
            <RiArrowRightSLine
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-text-soft-400 transition-transform group-hover:text-text-sub-600",
                isExpanded && "rotate-90",
              )}
            />
            {isExpanded ? (
              <RiFolderOpenLine className="size-3.5 shrink-0 text-text-soft-400" aria-hidden />
            ) : (
              <RiFolderLine className="size-3.5 shrink-0 text-text-soft-400" aria-hidden />
            )}
            <span className="truncate font-mono text-[11px] text-text-sub-600 group-hover:text-text-strong-950">
              {node.name}
            </span>
            {hasNonZeroStat(node.stat) && (
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
              </span>
            )}
          </button>
          {isExpanded && (
            <div className="space-y-0.5">
              {node.children.map((childNode) => renderTreeNode(childNode, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <button
        key={`file:${node.path}`}
        type="button"
        disabled={!onOpenFile}
        className={cn(
          "group flex w-full items-center gap-1.5 rounded-lg py-1 pr-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-base",
          onOpenFile && "cursor-pointer hover:bg-bg-soft-200",
        )}
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onOpenFile?.(node.path)}
      >
        {hasDirectoryNodes || depth > 0 ? (
          <span aria-hidden="true" className="size-3.5 shrink-0" />
        ) : null}
        <RiFile3Line className="size-3.5 shrink-0 text-text-soft-400" aria-hidden />
        <span className="truncate font-mono text-[11px] text-text-sub-600 group-hover:text-text-strong-950">
          {node.name}
        </span>
        {node.stat && (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    );
  };

  return (
    <div data-session-ui="changed-files-tree" className="space-y-0.5">
      {treeNodes.map((node) => renderTreeNode(node, 0))}
    </div>
  );
});

function collectDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}
