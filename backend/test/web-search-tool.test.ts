import { describe, expect, test } from "bun:test";
import { parseWebSearchResponse } from "../src/knowledge/gateway/web-search-tool";

// Unit tests for the pure block parser - the network call to Anthropic is not
// exercised here (that is the live retry), but every correctness rule the review
// called out is pinned: search-actually-ran, structured errors, source capture.

describe("parseWebSearchResponse", () => {
  test("captures sources + synthesis and marks searched=true", () => {
    const p = parseWebSearchResponse([
      { type: "server_tool_use", name: "web_search", input: { query: "x" } },
      {
        type: "web_search_tool_result",
        content: [
          { type: "web_search_result", url: "https://a.com", title: "A", page_age: "1 day" },
          { type: "web_search_result", url: "https://b.com", title: "B" },
        ],
      },
      { type: "text", text: "A and B say hello." },
    ]);
    expect(p.searched).toBe(true);
    expect(p.errors).toEqual([]);
    expect(p.sources).toEqual([
      { title: "A", url: "https://a.com", age: "1 day" },
      { title: "B", url: "https://b.com", age: undefined },
    ]);
    expect(p.text).toBe("A and B say hello.");
  });

  test("searched=false when the model answered WITHOUT a search (no tool block)", () => {
    const p = parseWebSearchResponse([{ type: "text", text: "I think it's 42 (from memory)." }]);
    expect(p.searched).toBe(false);
    expect(p.sources).toEqual([]);
  });

  test("surfaces Anthropic's in-200 structured search error", () => {
    const p = parseWebSearchResponse([
      { type: "server_tool_use", name: "web_search" },
      { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
    ]);
    expect(p.searched).toBe(true);
    expect(p.errors).toEqual(["max_uses_exceeded"]);
    expect(p.sources).toEqual([]);
  });

  test("caps sources at 10", () => {
    const results = Array.from({ length: 15 }, (_, i) => ({ type: "web_search_result", url: `https://s${i}.com`, title: `S${i}` }));
    const p = parseWebSearchResponse([{ type: "web_search_tool_result", content: results }]);
    expect(p.sources).toHaveLength(10);
  });
});
