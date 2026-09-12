import { describe, expect, test } from "bun:test";
import { RiHammerLine, RiHammerFill } from "@remixicon/react";
import type { TraceGlyph } from "@/components/chat/types";
import {
  familyForGlyph,
  familyForToolName,
  familyForWorkEntry,
  iconForWorkEntry,
  STEP_FAMILIES,
  STEP_ICON,
} from "./step-icons";

describe("step icon map", () => {
  test("every family has a glyph", () => {
    for (const family of STEP_FAMILIES) {
      expect(typeof STEP_ICON[family], family).toBe("function");
    }
  });

  test("the hammer is drawn nowhere", () => {
    for (const family of STEP_FAMILIES) {
      expect(STEP_ICON[family]).not.toBe(RiHammerLine);
      expect(STEP_ICON[family]).not.toBe(RiHammerFill);
    }
    // The T3 "hammer" slot (an uncatalogued tool call) now draws the tool glyph.
    const dynamic = iconForWorkEntry({ id: "d", label: "Create issue", tone: "tool", itemType: "dynamic_tool_call" });
    expect(dynamic).toBe(STEP_ICON.tool);
    expect(dynamic).not.toBe(RiHammerLine);
  });

  test("every trace glyph resolves to a family", () => {
    const glyphs: TraceGlyph[] = [
      "read", "edit", "write", "run", "search", "list", "fetch", "subagent", "reasoning", "task", "boot",
    ];
    for (const glyph of glyphs) expect(STEP_FAMILIES).toContain(familyForGlyph(glyph));
    expect(familyForGlyph("run")).toBe("shell");
    expect(familyForGlyph("task")).toBe("tool");
  });

  test("gateway calls settle their family by wire name", () => {
    expect(familyForToolName("memory_search")).toBe("memory");
    expect(familyForToolName("skill_activate")).toBe("playbook");
    expect(familyForToolName("skills_list")).toBe("playbook");
    expect(familyForToolName("child_session_create")).toBe("subagent");
    expect(familyForToolName("websearch")).toBe("search");
    expect(familyForToolName("webfetch")).toBe("web-fetch");
    expect(familyForToolName("bash")).toBeNull();
    expect(familyForToolName(null)).toBeNull();
  });

  test("the vendored T3 icon grammar maps onto the same families", () => {
    expect(familyForWorkEntry({ id: "1", label: "ls", tone: "tool", requestKind: "command" })).toBe("shell");
    expect(familyForWorkEntry({ id: "2", label: "Read", tone: "tool", requestKind: "file-read" })).toBe("file-read");
    expect(familyForWorkEntry({ id: "3", label: "Edit", tone: "tool", requestKind: "file-change" })).toBe("file-edit");
    expect(familyForWorkEntry({ id: "4", label: "Search", tone: "tool", itemType: "web_search" })).toBe("web-fetch");
    expect(familyForWorkEntry({ id: "5", label: "Agent", tone: "tool", taskId: "t" })).toBe("subagent");
    expect(familyForWorkEntry({ id: "6", label: "Thinking", tone: "thinking" })).toBe("reasoning");
    expect(familyForWorkEntry({ id: "7", label: "Boom", tone: "error" })).toBe("error");
  });
});
