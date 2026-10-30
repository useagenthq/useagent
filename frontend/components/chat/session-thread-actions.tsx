"use client";

import { RiCodeSSlashLine, RiLayoutRightLine, RiMarkdownLine, RiMore2Line } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import {
  Dropdown,
  DropdownMenu,
  DropdownMenuItem,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import {
  downloadThreadExport,
  formatThreadJson,
  formatThreadMarkdown,
  type ThreadExportData,
  type ThreadExportFormat,
} from "./thread-export";
import { RunFeedback } from "./run-feedback";
import { RAIL_ICON_BUTTON } from "./surface-chooser";
import { cx } from "@/utils/cx";

export function SessionThreadActions({
  runId,
  exportData,
  showSurfaceOpener,
  splitTooNarrow,
  onOpenSurfaces,
}: {
  runId: string;
  exportData: ThreadExportData;
  showSurfaceOpener: boolean;
  splitTooNarrow: boolean;
  onOpenSurfaces: () => void;
}) {
  const exportThread = (format: ThreadExportFormat) => {
    const content =
      format === "markdown"
        ? formatThreadMarkdown(
            exportData,
            window.location.origin,
            process.env.NEXT_PUBLIC_CANONICAL_TIMELINE === "1",
          )
        : formatThreadJson(exportData);
    downloadThreadExport(content, exportData.threadId, format);
  };

  return (
    <div className="flex items-center gap-2 sm:gap-3">
      <RunFeedback key={runId} runId={runId} />
        <Dropdown>
          <DropdownTrigger
            aria-label="Thread actions"
            className="flex size-8 shrink-0 items-center justify-center rounded-2lg text-foreground-icon-tertiary hover:bg-background-secondary-hover hover:text-text-primary"
          >
            <RiMore2Line className="size-4" aria-hidden />
          </DropdownTrigger>
          <DropdownMenu aria-label="Thread actions" placement="bottom end" className="w-max">
            <DropdownMenuItem
              id="export-markdown"
              textValue="Export as Markdown"
              onAction={() => exportThread("markdown")}
            >
              <RiMarkdownLine
                className="size-5 shrink-0 text-foreground-icon-secondary"
                aria-hidden
              />
              <span className="text-body-medium text-text-primary">Export as Markdown</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              id="export-json"
              textValue="Export as JSON"
              onAction={() => exportThread("json")}
            >
              <RiCodeSSlashLine
                className="size-5 shrink-0 text-foreground-icon-secondary"
                aria-hidden
              />
              <span className="text-body-medium text-text-primary">Export as JSON</span>
            </DropdownMenuItem>
          </DropdownMenu>
        </Dropdown>
      {/* In sheet mode (below md, or a too-narrow md+ split) this opens the surfaces rail. */}
      {showSurfaceOpener && (
        <Button
          variant="ghost"
          size="small"
          iconOnly
          leadingIcon={RiLayoutRightLine}
          onClick={onOpenSurfaces}
          title="Open side panel"
          aria-label="Open side panel"
          className={cx(RAIL_ICON_BUTTON, !splitTooNarrow && "md:hidden")}
        />
      )}
    </div>
  );
}
