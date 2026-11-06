"use client";

// The rail's surface switcher: one pill per surface the thread can show.
// Extracted from the session view so a new surface is one line here rather
// than a larger session view. Agents leads once a run has fanned out,
// Workspace appears once a workpiece is open, Diff once a real change set
// exists; Files, Editor, Terminal, Browser and Details are always there.

import {
  type RemixiconComponentType,
  RiCodeSSlashLine,
  RiComputerLine,
  RiFileList2Line,
  RiGitMergeLine,
  RiInformationLine,
  RiPagesLine,
  RiRobot2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { RAIL_TAB_LABEL_COLLAPSE, type SurfaceChoice } from "@/components/chat/surface-chooser";

export type RailTab = SurfaceChoice | "editor" | "workspace";

export function SessionRailTabs({
  railTab,
  hasSubagents,
  hasWorkspace,
  hasFiles,
  onSelect,
}: {
  railTab: RailTab | null;
  hasSubagents: boolean;
  hasWorkspace: boolean;
  hasFiles: boolean;
  onSelect: (tab: RailTab) => void;
}) {
  const tab = (id: RailTab, icon: RemixiconComponentType, label: string) => (
    <PillTab
      icon={icon}
      isSelected={railTab === id}
      onSelect={() => onSelect(id)}
      data-testid={`rail-tab-${id}`}
      labelClassName={RAIL_TAB_LABEL_COLLAPSE}
    >
      {label}
    </PillTab>
  );
  return (
    <PillTabList
      aria-label="Panels"
      className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {hasSubagents && tab("agents", RiRobot2Line, "Agents")}
      {tab("artifacts", RiFileList2Line, "Files")}
      {hasWorkspace && tab("workspace", RiPagesLine, "Workspace")}
      {hasFiles && tab("diff", RiGitMergeLine, "Diff")}
      {tab("editor", RiCodeSSlashLine, "Editor")}
      {tab("terminal", RiTerminalBoxLine, "Terminal")}
      {tab("desktop", RiComputerLine, "Browser")}
      {tab("details", RiInformationLine, "Details")}
    </PillTabList>
  );
}
