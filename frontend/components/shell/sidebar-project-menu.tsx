"use client";

import {
  type RemixiconComponentType,
  RiAddLine,
  RiListCheck2,
  RiMore2Line,
} from "@remixicon/react";
import { useRouter } from "next/navigation";

import {
  Dropdown,
  DropdownGroup,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import type { ProjectGroup } from "@/components/session-ui/project-thread-tree";
import { cx } from "@/utils/cx";

export interface ProjectMenuItem {
  readonly key: "open-tasks" | "new-thread";
  readonly label: string;
  readonly href: string;
}

/** Deep-link target for a project's task board (read by /tasks as ?project=). */
export function taskBoardHref(projectKey: string): string {
  return `/tasks?project=${encodeURIComponent(projectKey)}`;
}

/**
 * Ordered per-project actions - the single source for the kebab + right-click
 * menu, pure so the deep-link routes are unit-testable without rendering. Only
 * real, working routes are listed (no dead rows): "Open task board" (primary)
 * deep-links to the project's Kanban; "New thread in this project" reuses the
 * existing per-repo composer route. "Rename" is intentionally omitted - repos
 * carry no rename affordance.
 */
export function projectMenuItems(group: ProjectGroup): ProjectMenuItem[] {
  if (!group.fullName) return [];
  return [
    { key: "open-tasks", label: "Open task board", href: taskBoardHref(group.fullName) },
    {
      key: "new-thread",
      label: "New thread",
      href: `/agent/new?repo=${encodeURIComponent(group.fullName)}`,
    },
  ];
}

const ITEM_ICON: Record<ProjectMenuItem["key"], RemixiconComponentType> = {
  "open-tasks": RiListCheck2,
  "new-thread": RiAddLine,
};

/**
 * Per-project actions menu. The SAME menu is opened two ways - a hover-revealed
 * kebab (its trigger; kept visible while the menu is open) and a right-click on
 * the folder row (ProjectFolder owns `isOpen`/`setOpen` and drives this same
 * controlled Dropdown). Built on our base Dropdown, which already carries the
 * Board UI popover recipe (w-266, rounded 2xl, border-button-default,
 * bg-primary, p-2.5, shadow-dropdown, scale-95 + blur entry) and is non-modal
 * (Esc closes, arrows/Enter move, never locks sidebar scroll).
 */
export function SidebarProjectMenu({
  group,
  isOpen,
  setOpen,
}: {
  group: ProjectGroup;
  isOpen: boolean;
  setOpen: (open: boolean) => void;
}) {
  const router = useRouter();
  const items = projectMenuItems(group);
  if (items.length === 0) return null;

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <Dropdown isOpen={isOpen} onOpenChange={setOpen}>
      <DropdownTrigger
        aria-label={`Project actions for ${group.label}`}
        className={cx(
          "flex size-7 shrink-0 items-center justify-center rounded-2lg text-foreground-icon-tertiary transition-opacity",
          "hover:bg-background-secondary-hover hover:text-text-primary",
          "opacity-0 group-hover/proj:opacity-100 group-focus-within/proj:opacity-100",
          isOpen && "opacity-100",
        )}
      >
        <RiMore2Line className="size-4" aria-hidden />
      </DropdownTrigger>
      <DropdownPopover
        aria-label={`Project actions for ${group.label}`}
        placement="bottom end"
        className="w-max"
      >
        <DropdownGroup>
          {items.map((item) => {
            const Icon = ITEM_ICON[item.key];
            return (
              <DropdownItem key={item.key} className="px-2 py-1.5" onSelect={() => go(item.href)}>
                <Icon className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
                <span className="truncate text-body-medium text-text-primary">{item.label}</span>
              </DropdownItem>
            );
          })}
        </DropdownGroup>
      </DropdownPopover>
    </Dropdown>
  );
}
