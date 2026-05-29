"use client";

import { RiCloseLine, RiSearch2Line } from "@remixicon/react";
import * as React from "react";

const flavors = [
  "Black sesame",
  "Chocolate",
  "Mango",
  "Mint chip",
  "Pistachio",
  "Strawberry",
  "Vanilla",
];

export function SearchList() {
  const [query, setQuery] = React.useState("");
  const results = flavors.filter((flavor) => flavor.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-md">
      <label className="flex items-center gap-2 border-b border-border-button-default px-3 py-2.5">
        <RiSearch2Line className="size-4 text-text-tertiary" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search flavors"
          placeholder="Search flavors"
          className="min-w-0 flex-1 bg-transparent text-body-2-regular outline-none placeholder:text-text-placeholder"
        />
        {query ? (
          <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
            <RiCloseLine className="size-4 text-text-tertiary" />
          </button>
        ) : null}
      </label>
      <div className="max-h-52 overflow-y-auto p-1.5">
        {results.length ? (
          results.map((flavor) => (
            <button
              type="button"
              key={flavor}
              className="flex w-full rounded-lg px-2.5 py-2 text-left text-body-2-regular text-text-secondary hover:bg-background-primary-hover hover:text-text-primary"
            >
              {flavor}
            </button>
          ))
        ) : (
          <p className="px-2.5 py-8 text-center text-body-2-regular text-text-tertiary">
            No flavors found
          </p>
        )}
      </div>
    </div>
  );
}
