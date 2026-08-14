"use client";

import {
  RiAddLine,
  RiBarChart2Line,
  RiCheckboxCircleLine,
  RiDashboardLine,
  RiHome4Line,
  RiSearch2Line,
  RiStackLine,
} from "@remixicon/react";
import * as React from "react";

const items = [
  { key: "home", label: "Home", section: "Workspace", icon: RiHome4Line },
  {
    key: "tasks",
    label: "Agent tasks",
    section: "Workspace",
    icon: RiCheckboxCircleLine,
    count: 3,
  },
  { key: "inbox", label: "Inbox", section: "Workspace", icon: RiDashboardLine },
  { key: "suppliers", label: "Suppliers", section: "Objects", icon: RiStackLine, add: true },
  { key: "inventory", label: "Inventory", section: "Objects", icon: RiBarChart2Line },
] as const;

export function SidebarNav() {
  const [active, setActive] = React.useState("tasks");
  const [query, setQuery] = React.useState("");
  const visible = items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));

  return (
    <nav
      className="w-full max-w-64 rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-2 shadow-regular-md"
      aria-label="Beautiful UI workspace"
    >
      <label className="mb-3 flex items-center gap-2 rounded-lg bg-bg-weak-50 px-2.5 py-2">
        <RiSearch2Line className="size-4 text-text-soft-400" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Quick search"
          className="min-w-0 flex-1 bg-transparent text-paragraph-sm outline-none placeholder:text-text-soft-400"
        />
      </label>
      {["Workspace", "Objects"].map((section) => (
        <div key={section} className="mb-3">
          <p className="px-2 py-1 text-mono-label text-text-soft-400">{section}</p>
          {visible
            .filter((item) => item.section === section)
            .map(({ key, label, icon: Icon, ...item }) => (
              <button
                key={key}
                type="button"
                onClick={() => setActive(key)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-label-sm transition-colors ${active === key ? "bg-primary-lighter text-primary-base" : "text-text-sub-600 hover:bg-bg-weak-50"}`}
              >
                <Icon className="size-4" />
                <span className="flex-1 text-left">{label}</span>
                {"count" in item ? <span className="text-paragraph-xs">{item.count}</span> : null}
                {"add" in item ? <RiAddLine className="size-4" /> : null}
              </button>
            ))}
        </div>
      ))}
    </nav>
  );
}
