"use client";

import { useMemo, useState } from "react";
import {
  RiAlarmWarningLine,
  RiArrowLeftRightLine,
  RiEditLine,
  RiFileTextLine,
  RiHomeHeartLine,
  RiHotelBedLine,
  RiLogoutBoxRLine,
  RiMore2Fill,
  RiPrinterLine,
  RiSearchLine,
  RiUserHeartLine,
  RiWalkLine,
} from "@remixicon/react";
import { Focusable } from "react-aria-components";
import {
  Dropdown,
  DropdownGroup,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { Avatar } from "@/components/base/avatar/avatar";
import { Chip } from "@/components/base/badges/chip";
import { IconButton } from "@/components/base/buttons/icon-button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { InputBase } from "@/components/base/input/input";
import { Pagination } from "@/components/base/pagination/pagination";
import { Select, SelectItem } from "@/components/base/select/select";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { ChevronSortDown } from "@/components/foundations/icons/chevrons";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → medical profile dashboard → Frame 89 (node
 * 3950:5981) — Figma reuses the dashboard's customers table verbatim
 * (same "Purchase / Status / Last updated / Price" columns, "1,262
 * customers" placeholder copy) rather than a medical-specific design, so
 * this is a from-scratch column set suited to a patient roster instead of
 * a 1:1 port: admission type, clinical status, condition tags, and next
 * appointment date in place of purchase/price.
 */

type StatusColor = "lime" | "yellow" | "rose" | "cyan" | "blue";
type PatientStatus = { label: string; color: StatusColor };

const STATUSES: PatientStatus[] = [
  { label: "Stable", color: "lime" },
  { label: "Under observation", color: "yellow" },
  { label: "Critical", color: "rose" },
  { label: "Recovering", color: "cyan" },
  { label: "In treatment", color: "blue" },
];

/** All condition tags share the one grey chip treatment (same bold size as
 *  the status chips) — the status column owns the color signal. */
const CONDITIONS = [
  "Diabetes",
  "Hypertension",
  "Asthma",
  "Fracture",
  "Post-op",
  "Pregnancy",
  "Allergy",
  "Migraine",
];

const DOCTORS = ["Dr. Clarkson", "Dr. Vaccaro", "Dr. Rhiel", "Dr. Bator", "Dr. Torff"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Patient = {
  id: number;
  name: string;
  avatar?: string;
  initialsColor?: "neutral" | "blue";
  admission: "inpatient" | "outpatient" | "discharged" | "emergency";
  status: PatientStatus;
  conditions: string[];
  doctor: string;
  nextAppointment: string;
  selected?: boolean;
};

const PHOTO_PEOPLE: { name: string; avatar: string }[] = [
  { name: "John Clarkson", avatar: "/avatars/john-clarkson.webp" },
  { name: "Aspen Lubin", avatar: "/avatars/aspen-lubin.webp" },
  { name: "Michael Ekstrom", avatar: "/avatars/michael-ekstrom.webp" },
  { name: "Kianna Vaccaro", avatar: "/avatars/kianna-vaccaro.webp" },
  { name: "Livia Saris", avatar: "/avatars/livia-saris.webp" },
  { name: "Jaydon Aminoff", avatar: "/avatars/jaydon-aminoff.webp" },
  { name: "Maria Lubin", avatar: "/avatars/maria-lubin.webp" },
  { name: "Ann Press", avatar: "/avatars/ann-press.webp" },
];

const FIRST_NAMES = ["Marcus", "Cheyenne", "Alfredo", "Talan", "Roger", "Cristofer", "Emery", "Kadin", "Nolan", "Ruben", "Skylar", "Hanna", "Corey", "Miracle", "Zaire", "Cooper", "Leilani", "Alena", "Terry", "Jaxson", "Kaiya", "Omar", "Phoenix", "Adison", "Gretchen", "Nova", "Ellis", "Dulce", "Wilson"];
const LAST_NAMES = ["Culhane", "Herwitz", "Septimus", "Bergson", "Curtis", "Vetrovs", "Rhiel", "Dokidis", "Kenter", "Stanton", "Baptista", "Workman", "Torff", "Calzoni", "Rosser", "Geidt", "Bator", "Vaccaro", "Lipshutz", "Botosh"];

/** mulberry32 — tiny deterministic PRNG so the demo data is stable. */
function makeRng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function initialsOf(name: string) {
  return name.split(" ").slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

const PATIENTS: Patient[] = (() => {
  const rng = makeRng(7);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
  const total = 540;

  return Array.from({ length: total }, (_, i) => {
    const status = pick(STATUSES);
    const admission: Patient["admission"] =
      status.label === "Critical"
        ? pick(["inpatient", "emergency"] as const)
        : pick(["inpatient", "outpatient", "discharged"] as const);
    const conditionCount = 1 + Math.floor(rng() * 2);
    const conditions = [
      ...new Set(Array.from({ length: conditionCount }, () => pick(CONDITIONS))),
    ];
    const month = pick(MONTHS);
    const day = 1 + Math.floor(rng() * 28);
    const nextAppointment = `${month} ${String(day).padStart(2, "0")}, 2026`;

    const base = {
      id: i,
      admission,
      status,
      conditions,
      doctor: pick(DOCTORS),
      nextAppointment,
    };

    if (i < PHOTO_PEOPLE.length) {
      return { ...base, name: PHOTO_PEOPLE[i].name, avatar: PHOTO_PEOPLE[i].avatar, selected: i === 1 || i === 2 };
    }
    const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    return { ...base, name, initialsColor: rng() > 0.5 ? "blue" : ("neutral" as const) };
  });
})();

// Pin the first two rows so the default view always leads with a
// "Recovering" and an "In treatment" patient (showing off both chip colors).
PATIENTS[0].status = STATUSES[3]; // Recovering
PATIENTS[0].admission = "outpatient";
PATIENTS[1].status = STATUSES[4]; // In treatment
PATIENTS[1].admission = "inpatient";

const PER_PAGE = 12;

/** Icon + label rows, same structure as the sidebar's Board team dropdown
 *  (`TeamMenuItem`: leading icon in foreground/icon/secondary, then the
 *  label) — just inside a `Select` instead of a popover menu. */
const ADMISSION_OPTIONS: {
  id: Patient["admission"];
  label: string;
  icon: typeof RiHotelBedLine;
}[] = [
  { id: "inpatient", label: "Inpatient", icon: RiHotelBedLine },
  { id: "outpatient", label: "Outpatient", icon: RiWalkLine },
  { id: "discharged", label: "Discharged", icon: RiHomeHeartLine },
  { id: "emergency", label: "Emergency", icon: RiAlarmWarningLine },
];

function AdmissionSelect({ defaultValue, name }: { defaultValue: Patient["admission"]; name: string }) {
  return (
    <Select
      aria-label={`Admission status for ${name}`}
      defaultSelectedKey={defaultValue}
      className="w-[150px]"
      // Leading icon in the trigger value reads 2px too far from the edge at
      // the default px-2.5 — trim the left inset only (right stays 10px).
      triggerClassName="pl-2"
    >
      {ADMISSION_OPTIONS.map((option) => (
        <SelectItem key={option.id} id={option.id} textValue={option.label}>
          <option.icon className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
          {option.label}
        </SelectItem>
      ))}
    </Select>
  );
}

/** Icon-only row action with a "tooltip medium" label — the trigger must be
 *  focusable for react-aria's `TooltipTrigger`, so `IconButton` (a plain
 *  `<button>`) is wrapped in `Focusable`, same pattern as the Tooltip docs
 *  example. */
function RowActionButton({
  icon,
  label,
}: {
  icon: typeof RiFileTextLine;
  label: string;
}) {
  return (
    <TooltipTrigger delay={200}>
      <Focusable>
        <IconButton icon={icon} size="small" aria-label={label} />
      </Focusable>
      <Tooltip size="md">{label}</Tooltip>
    </TooltipTrigger>
  );
}

const MORE_MENU_ACTIONS = [
  { icon: RiUserHeartLine, label: "Assign care team" },
  { icon: RiPrinterLine, label: "Print summary" },
  { icon: RiArrowLeftRightLine, label: "Transfer ward" },
  { icon: RiLogoutBoxRLine, label: "Discharge patient" },
] as const;

/** The "⋮" action: tooltip on hover, contextual dropdown menu on click. The
 *  trigger is styled to match `IconButton`'s small secondary recipe (nesting
 *  the real IconButton inside DropdownTrigger would nest <button>s). */
function RowMoreMenu({ name }: { name: string }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <Dropdown isOpen={isOpen} onOpenChange={setIsOpen}>
      <TooltipTrigger delay={200}>
        <DropdownTrigger
          aria-label={`More actions for ${name}`}
          className={cx(
            "relative inline-flex size-8 shrink-0 items-center justify-center rounded-2lg",
            "border border-border-button-default bg-background-primary-default text-foreground-icon-primary shadow-xs",
            "transition-[background-color,border-color,box-shadow,color] duration-150 ease",
            "hover:border-border-button-hover hover:bg-background-primary-hover",
            isOpen && "border-border-button-active bg-background-primary-active",
          )}
        >
          <RiMore2Fill className="size-4 shrink-0" aria-hidden />
        </DropdownTrigger>
        <Tooltip size="md">More actions</Tooltip>
      </TooltipTrigger>
      <DropdownPopover aria-label={`More actions for ${name}`} placement="bottom end" className="w-[220px] p-2">
        <DropdownGroup>
          {MORE_MENU_ACTIONS.map(({ icon: Icon, label }) => (
            <DropdownItem key={label} onSelect={() => setIsOpen(false)} className="px-2 py-1.5">
              <Icon className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
              <span className="truncate text-body-medium whitespace-nowrap text-text-primary">{label}</span>
            </DropdownItem>
          ))}
        </DropdownGroup>
      </DropdownPopover>
    </Dropdown>
  );
}

type SortKey = "name" | "nextAppointment";
type SortState = { key: SortKey; dir: "asc" | "desc" } | null;

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey?: SortKey;
  sort?: SortState;
  onSort?: (key: SortKey) => void;
}) {
  const active = !!sortKey && sort?.key === sortKey;
  const content = (
    <>
      <span className={cx("text-body-medium whitespace-nowrap", active ? "text-text-primary" : "text-text-tertiary")}>
        {label}
      </span>
      <span className="flex size-6 shrink-0 items-center justify-center">
        {sortKey && (
          <ChevronSortDown
            className={cx(
              "size-6 transition-[transform,color] duration-150 ease",
              active ? "text-text-secondary" : "text-text-tertiary",
              active && sort?.dir === "asc" && "rotate-180",
            )}
          />
        )}
      </span>
    </>
  );

  if (!sortKey) {
    return <div className="flex items-center gap-0.5">{content}</div>;
  }

  return (
    <button
      type="button"
      aria-label={`Sort by ${label}`}
      onClick={() => onSort?.(sortKey)}
      className="flex cursor-pointer items-center gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-border-focus-ring"
    >
      {content}
    </button>
  );
}

function PatientRow({
  patient,
  isSelected,
  onToggle,
  showBorder = true,
}: {
  patient: Patient;
  isSelected: boolean;
  onToggle: (id: number, selected: boolean) => void;
  showBorder?: boolean;
}) {
  return (
    <div className={cx("flex w-full items-center", showBorder && "border-b border-separator-border")}>
      <div className="flex min-w-0 flex-1 items-center gap-2 py-2.5">
        <Checkbox
          isSelected={isSelected}
          onChange={(selected) => onToggle(patient.id, selected)}
          aria-label={`Select ${patient.name}`}
        />
        <div className="flex min-w-0 items-center gap-2">
          {patient.avatar ? (
            <Avatar size="sm" src={patient.avatar} alt="" />
          ) : (
            <Avatar size="sm" color={patient.initialsColor} initials={initialsOf(patient.name)} />
          )}
          <span className="truncate text-body-medium text-text-primary">{patient.name}</span>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
        <AdmissionSelect defaultValue={patient.admission} name={patient.name} />
      </div>
      <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
        <Chip variant="bold" color={patient.status.color}>
          {patient.status.label}
        </Chip>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 px-3 py-2.5">
        {patient.conditions.map((condition) => (
          <Chip key={condition} variant="bold" color="gray">
            {condition}
          </Chip>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
        <span className="text-body-medium whitespace-nowrap text-text-primary">{patient.nextAppointment}</span>
      </div>
      <div className="flex w-[140px] shrink-0 items-center justify-end gap-2.5 px-3 py-2.5">
        <RowActionButton icon={RiFileTextLine} label="View chart" />
        <RowActionButton icon={RiEditLine} label="Edit patient" />
        <RowMoreMenu name={patient.name} />
      </div>
    </div>
  );
}

export function PatientsTable() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");
  const [conditionFilter, setConditionFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(PATIENTS.filter((p) => p.selected).map((p) => p.id)),
  );

  const onSort = (key: SortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  };

  const toggleRow = (id: number, isSelected: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (isSelected) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PATIENTS.filter(
      (p) =>
        (statusFilter === "all" || p.status.label === statusFilter) &&
        (conditionFilter === "all" || p.conditions.includes(conditionFilter)) &&
        (q === "" || p.name.toLowerCase().includes(q)),
    );
  }, [statusFilter, conditionFilter, query]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const arr = [...filtered];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      const cmp =
        key === "name"
          ? a.name.localeCompare(b.name)
          : Date.parse(a.nextAppointment) - Date.parse(b.nextAppointment);
      return dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const rows = sorted.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);

  const selectedOnPage = rows.filter((p) => selected.has(p.id)).length;
  const allOnPageSelected = rows.length > 0 && selectedOnPage === rows.length;
  const someOnPageSelected = selectedOnPage > 0 && !allOnPageSelected;

  const toggleAllOnPage = (isSelected: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of rows) {
        if (isSelected) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  };

  const resetPage = () => setPage(1);
  const hasPagination = totalPages > 1;

  return (
    <section
      className={cx(
        "flex w-full flex-col rounded-2xl border border-border-table pt-2",
        hasPagination ? "pb-3" : "pb-0",
      )}
    >
      {/* Toolbar */}
      <div className="flex w-full flex-col items-start gap-3 px-3 py-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col justify-center">
          <p className="text-body-medium whitespace-nowrap text-text-tertiary">Total Results</p>
          <p className="text-body-medium whitespace-nowrap text-text-primary">
            {filtered.length.toLocaleString()} patients
          </p>
        </div>
        <div className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-2.5 overflow-x-auto px-3 sm:mx-0 sm:w-auto sm:flex-wrap sm:justify-end sm:overflow-visible sm:px-0">
          <Select
            aria-label="Filter by status"
            className="shrink-0"
            selectedKey={statusFilter}
            onSelectionChange={(k) => {
              setStatusFilter(String(k));
              resetPage();
            }}
          >
            <SelectItem id="all" textValue="All statuses">
              All statuses
            </SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s.label} id={s.label} textValue={s.label}>
                {s.label}
              </SelectItem>
            ))}
          </Select>
          <Select
            aria-label="Filter by condition"
            className="shrink-0"
            selectedKey={conditionFilter}
            onSelectionChange={(k) => {
              setConditionFilter(String(k));
              resetPage();
            }}
          >
            <SelectItem id="all" textValue="All conditions">
              All conditions
            </SelectItem>
            {CONDITIONS.map((c) => (
              <SelectItem key={c} id={c} textValue={c}>
                {c}
              </SelectItem>
            ))}
          </Select>
          <InputBase
            aria-label="Search patients"
            placeholder="Search"
            leadingIcon={RiSearchLine}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              resetPage();
            }}
            fieldClassName="min-w-[153px] flex-1 rounded-full bg-background-secondary-default sm:w-[153px] sm:min-w-0 sm:flex-none"
            className="text-body-medium"
          />
        </div>
      </div>

      {/* Table grid: headers + rows share a min width and scroll horizontally together */}
      <div className="mt-2 w-full overflow-x-auto">
        <div className="flex min-w-[960px] flex-col">
          {/* Column headers */}
          <div className="flex w-full items-center border-y border-separator-border bg-background-secondary-default pl-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 py-2.5">
              <Checkbox
                isSelected={allOnPageSelected}
                isIndeterminate={someOnPageSelected}
                onChange={toggleAllOnPage}
                aria-label="Select all patients on this page"
              />
              <SortableHeader label="Patient" sortKey="name" sort={sort} onSort={onSort} />
            </div>
            <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
              <SortableHeader label="Admission" />
            </div>
            <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
              <SortableHeader label="Status" />
            </div>
            <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
              <SortableHeader label="Condition" />
            </div>
            <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
              <SortableHeader label="Next appointment" sortKey="nextAppointment" sort={sort} onSort={onSort} />
            </div>
            <div className="flex w-[140px] shrink-0 items-center px-3 py-2.5">
              <span className="text-body-medium whitespace-nowrap text-text-tertiary">Actions</span>
            </div>
          </div>

          {/* Rows */}
          <div className="flex w-full flex-col pl-3">
            {rows.length > 0 ? (
              rows.map((patient, index) => (
                <PatientRow
                  key={patient.id}
                  patient={patient}
                  isSelected={selected.has(patient.id)}
                  onToggle={toggleRow}
                  showBorder={hasPagination || index < rows.length - 1}
                />
              ))
            ) : (
              <div className="flex w-full items-center justify-center py-10 pr-3">
                <span className="text-body-medium text-text-tertiary">No patients match your filters.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Pagination footer — only when the results actually paginate */}
      {hasPagination && (
        <div className="px-3 pt-3">
          <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} />
        </div>
      )}
    </section>
  );
}
