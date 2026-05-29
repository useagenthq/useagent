"use client";

import { useMemo, useState } from "react";
import {
  RiArchiveLine,
  RiDeleteBin6Line,
  RiDownload2Line,
  RiEditLine,
  RiFileCopyLine,
  RiMore2Fill,
  RiSearchLine,
  RiUserLine,
} from "@remixicon/react";
import { Focusable } from "react-aria-components";
import { Avatar } from "@/components/base/avatar/avatar";
import { Chip } from "@/components/base/badges/chip";
import { StatusDot } from "@/components/base/badges/status-dot";
import { IconButton } from "@/components/base/buttons/icon-button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import {
  Dropdown,
  DropdownGroup,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { InputBase } from "@/components/base/input/input";
import { Pagination } from "@/components/base/pagination/pagination";
import { Select, SelectItem } from "@/components/base/select/select";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { ChevronSortDown } from "@/components/foundations/icons/chevrons";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → dashboard 1 → Frame 89 (node 3731:3201).
 *
 * Customers table: toolbar (total + working filter selects + search), sortable
 * column header row, rows with selection checkbox, avatar, status select,
 * status chip, date, price chip, row actions — and a Pagination footer.
 *
 * The dataset is generated deterministically (stable across renders, so no
 * hydration mismatch). The first eight rows use photo avatars; the rest use
 * initials. Price / product / region / search filters all narrow the rows and
 * re-drive the total + pagination.
 */

type StatusColor = "lime" | "yellow" | "rose" | "cyan";
type Status = { label: string; color: StatusColor };

const STATUSES: Status[] = [
  { label: "Shipped", color: "lime" },
  { label: "Delivery waiting", color: "yellow" },
  { label: "Delivery failed", color: "rose" },
  { label: "Confirmed", color: "cyan" },
];

const PRODUCTS = ["Sneakers", "Backpack", "Smart watch", "Headphones", "Sunglasses", "Wallet"];
const REGIONS = ["North America", "Europe", "Asia", "Oceania"];

const PRICE_BUCKETS: { id: string; label: string; test: (p: number) => boolean }[] = [
  { id: "all", label: "All prices", test: () => true },
  { id: "under-100", label: "Under $100", test: (p) => p < 100 },
  { id: "100-500", label: "$100 – $500", test: (p) => p >= 100 && p <= 500 },
  { id: "500-1000", label: "$500 – $1,000", test: (p) => p > 500 && p <= 1000 },
  { id: "over-1000", label: "Over $1,000", test: (p) => p > 1000 },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Customer = {
  id: number;
  name: string;
  avatar?: string;
  initialsColor?: "neutral" | "blue";
  purchase: "completed" | "waiting" | "processing";
  status: Status;
  product: string;
  region: string;
  price: number;
  updated: string;
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

const FIRST_NAMES = ["Marcus", "Cheyenne", "Alfredo", "Talan", "Roger", "Cristofer", "Emery", "Kadin", "Nolan", "Ruben", "Skylar", "Hanna", "Corey", "Miracle", "Zaire", "Cooper", "Leilani", "Alena", "Terry", "Jaxson", "Kaiya", "Omar", "Phoenix", "Adison", "Gretchen", "Marcus", "Nova", "Ellis", "Dulce", "Wilson"];
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

function formatPrice(n: number) {
  return n >= 1000
    ? `$${Math.floor(n / 1000)}.${String(n % 1000).padStart(3, "0")}`
    : `$${n}`;
}

function initialsOf(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

const CUSTOMERS: Customer[] = (() => {
  const rng = makeRng(42);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
  const total = 660;

  return Array.from({ length: total }, (_, i) => {
    const status = pick(STATUSES);
    const purchase: Customer["purchase"] =
      rng() < 0.24
        ? "processing"
        : status.label === "Shipped" || status.label === "Confirmed"
          ? "completed"
          : "waiting";
    const price = 20 + Math.floor(rng() * 3980);
    const month = pick(MONTHS);
    const day = 1 + Math.floor(rng() * 28);
    const updated = `${month} ${String(day).padStart(2, "0")}, 2026`;

    const base = {
      id: i,
      purchase,
      status,
      product: pick(PRODUCTS),
      region: pick(REGIONS),
      price,
      updated,
    };

    if (i < PHOTO_PEOPLE.length) {
      return { ...base, name: PHOTO_PEOPLE[i].name, avatar: PHOTO_PEOPLE[i].avatar, selected: i === 1 || i === 2 };
    }
    const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    return { ...base, name, initialsColor: rng() > 0.5 ? "blue" : ("neutral" as const) };
  });
})();

const PER_PAGE = 12;

function PurchaseSelect({ defaultValue, name }: { defaultValue: Customer["purchase"]; name: string }) {
  return (
    <Select
      aria-label={`Purchase status for ${name}`}
      defaultSelectedKey={defaultValue}
      className="w-[142px]"
    >
      <SelectItem id="completed" textValue="Completed">
        <StatusDot color="green" />
        Completed
      </SelectItem>
      <SelectItem id="waiting" textValue="Waiting">
        <StatusDot color="yellow" />
        Waiting
      </SelectItem>
      <SelectItem id="processing" textValue="Processing">
        <StatusDot color="indigo" />
        Processing
      </SelectItem>
    </Select>
  );
}

type SortKey = "name" | "updated" | "price";
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
      <span
        className={cx(
          "text-body-medium whitespace-nowrap",
          active ? "text-text-primary" : "text-text-tertiary",
        )}
      >
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
      className="flex cursor-pointer items-center gap-0.5 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-border-focus-ring rounded-sm"
    >
      {content}
    </button>
  );
}

/** Icon-only row action with a tooltip label — `IconButton` (a plain
 *  `<button>`) is wrapped in `Focusable` so react-aria's `TooltipTrigger`
 *  can attach hover/focus behavior, same pattern as the patients table. */
function RowActionButton({
  icon,
  label,
}: {
  icon: typeof RiEditLine;
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
  { icon: RiUserLine, label: "View profile" },
  { icon: RiFileCopyLine, label: "Duplicate row" },
  { icon: RiDownload2Line, label: "Download invoice" },
  { icon: RiArchiveLine, label: "Archive customer" },
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

function CustomerRow({
  customer,
  isSelected,
  onToggle,
  showBorder = true,
}: {
  customer: Customer;
  isSelected: boolean;
  onToggle: (id: number, selected: boolean) => void;
  showBorder?: boolean;
}) {
  return (
    <div className={cx("flex w-full items-center", showBorder && "border-b border-separator-border")}>
      <div className="flex min-w-0 flex-1 items-center gap-2 py-2.5">
        <Checkbox
          isSelected={isSelected}
          onChange={(selected) => onToggle(customer.id, selected)}
          aria-label={`Select ${customer.name}`}
        />
        <div className="flex min-w-0 items-center gap-2">
          {customer.avatar ? (
            <Avatar size="sm" src={customer.avatar} alt="" />
          ) : (
            <Avatar size="sm" color={customer.initialsColor} initials={initialsOf(customer.name)} />
          )}
          <span className="truncate text-body-medium text-text-primary">
            {customer.name}
          </span>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
        <PurchaseSelect defaultValue={customer.purchase} name={customer.name} />
      </div>
      <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
        <Chip variant="bold" color={customer.status.color}>
          {customer.status.label}
        </Chip>
      </div>
      <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
        <span className="text-body-medium whitespace-nowrap text-text-primary">
          {customer.updated}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
        <Chip variant="subtle" color="gray">
          {formatPrice(customer.price)}
        </Chip>
      </div>
      <div className="flex w-[140px] shrink-0 items-center justify-end gap-2.5 px-3 py-2.5">
        <RowActionButton icon={RiDeleteBin6Line} label="Delete" />
        <RowActionButton icon={RiEditLine} label="Edit" />
        <RowMoreMenu name={customer.name} />
      </div>
    </div>
  );
}

export function CustomersTable() {
  const [page, setPage] = useState(1);
  const [priceFilter, setPriceFilter] = useState("all");
  const [productFilter, setProductFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(CUSTOMERS.filter((c) => c.selected).map((c) => c.id)),
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
    const bucket = PRICE_BUCKETS.find((b) => b.id === priceFilter) ?? PRICE_BUCKETS[0];
    const q = query.trim().toLowerCase();
    return CUSTOMERS.filter(
      (c) =>
        bucket.test(c.price) &&
        (productFilter === "all" || c.product === productFilter) &&
        (regionFilter === "all" || c.region === regionFilter) &&
        (q === "" || c.name.toLowerCase().includes(q)),
    );
  }, [priceFilter, productFilter, regionFilter, query]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const arr = [...filtered];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      let cmp = 0;
      if (key === "name") cmp = a.name.localeCompare(b.name);
      else if (key === "price") cmp = a.price - b.price;
      else cmp = Date.parse(a.updated) - Date.parse(b.updated);
      return dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const rows = sorted.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);

  const selectedOnPage = rows.filter((c) => selected.has(c.id)).length;
  const allOnPageSelected = rows.length > 0 && selectedOnPage === rows.length;
  const someOnPageSelected = selectedOnPage > 0 && !allOnPageSelected;

  const toggleAllOnPage = (isSelected: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of rows) {
        if (isSelected) next.add(c.id);
        else next.delete(c.id);
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
              {filtered.length.toLocaleString()} customers
            </p>
          </div>
          <div className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-2.5 overflow-x-auto px-3 sm:mx-0 sm:w-auto sm:flex-wrap sm:justify-end sm:overflow-visible sm:px-0">
            <Select
              aria-label="Filter by price"
              className="shrink-0"
              popoverClassName="min-w-40"
              selectedKey={priceFilter}
              onSelectionChange={(k) => {
                setPriceFilter(String(k));
                resetPage();
              }}
            >
              {PRICE_BUCKETS.map((b) => (
                <SelectItem key={b.id} id={b.id} textValue={b.label}>
                  {b.label}
                </SelectItem>
              ))}
            </Select>
            <Select
              aria-label="Filter by product"
              className="shrink-0"
              popoverClassName="min-w-40"
              selectedKey={productFilter}
              onSelectionChange={(k) => {
                setProductFilter(String(k));
                resetPage();
              }}
            >
              <SelectItem id="all" textValue="All products">
                All products
              </SelectItem>
              {PRODUCTS.map((p) => (
                <SelectItem key={p} id={p} textValue={p}>
                  {p}
                </SelectItem>
              ))}
            </Select>
            <Select
              aria-label="Filter by region"
              className="shrink-0"
              popoverClassName="min-w-40"
              selectedKey={regionFilter}
              onSelectionChange={(k) => {
                setRegionFilter(String(k));
                resetPage();
              }}
            >
              <SelectItem id="all" textValue="All regions">
                All regions
              </SelectItem>
              {REGIONS.map((r) => (
                <SelectItem key={r} id={r} textValue={r}>
                  {r}
                </SelectItem>
              ))}
            </Select>
            <InputBase
              aria-label="Search customers"
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
        <div className="flex min-w-[860px] flex-col">
        {/* Column headers */}
        <div className="flex w-full items-center border-y border-separator-border bg-background-secondary-default pl-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 py-2.5">
            <Checkbox
              isSelected={allOnPageSelected}
              isIndeterminate={someOnPageSelected}
              onChange={toggleAllOnPage}
              aria-label="Select all customers on this page"
            />
            <SortableHeader label="Customer name" sortKey="name" sort={sort} onSort={onSort} />
          </div>
          <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
            <SortableHeader label="Purchase" />
          </div>
          <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
            <SortableHeader label="Status" />
          </div>
          <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
            <SortableHeader label="Last updated" sortKey="updated" sort={sort} onSort={onSort} />
          </div>
          <div className="flex min-w-0 flex-1 items-center px-3 py-2.5">
            <SortableHeader label="Price" sortKey="price" sort={sort} onSort={onSort} />
          </div>
          <div className="flex w-[140px] shrink-0 items-center px-3 py-2.5">
            <span className="text-body-medium whitespace-nowrap text-text-tertiary">Actions</span>
          </div>
        </div>

        {/* Rows */}
        <div className="flex w-full flex-col pl-3">
        {rows.length > 0 ? (
          rows.map((customer, index) => (
            <CustomerRow
              key={customer.id}
              customer={customer}
              isSelected={selected.has(customer.id)}
              onToggle={toggleRow}
              showBorder={hasPagination || index < rows.length - 1}
            />
          ))
        ) : (
          <div className="flex w-full items-center justify-center py-10 pr-3">
            <span className="text-body-medium text-text-tertiary">
              No customers match your filters.
            </span>
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
