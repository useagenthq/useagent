import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PermissionModeChip,
  PermissionModePanel,
  PermissionModeTag,
  permissionModeLabel,
  permissionModeOptions,
} from "./permission-mode-chip";

const BYPASS_ONLY =
  "This agent cannot stop to ask you first, so it always works without asking.";

describe("permission mode faces", () => {
  test("every stored mode wears one of the panel's four faces", () => {
    expect(permissionModeLabel("read-only")).toBe("Plan mode");
    expect(permissionModeLabel("approval-required")).toBe("Manual");
    expect(permissionModeLabel("auto-accept-edits")).toBe("Auto");
    expect(permissionModeLabel("full-access")).toBe("Bypass all");
    expect(permissionModeLabel("auto")).toBe("Auto");
  });

  test("the rows say in one line what each mode lets through, per engine", () => {
    const rows = permissionModeOptions(undefined);
    expect(rows.map((row) => [row.id, row.label, row.description])).toEqual([
      ["auto", "Auto", "Edits run, commands ask"],
      ["manual", "Manual", "Asks to run or edit"],
      ["plan", "Plan mode", "Reads, edits nothing"],
      ["bypass", "Bypass all", "Runs, edits unasked"],
    ]);
    // The full sentences ride on the rows' titles, Auto's per engine.
    expect(rows.map((row) => row.title)).toEqual([
      "File edits go through without asking; commands still ask.",
      "Asks before running a command or changing a file.",
      "Reads and answers; never runs commands or changes files.",
      "Runs commands and changes files without asking.",
    ]);
    // Codex's workspace-write policy also runs workspace-bound commands unasked; Auto says so there.
    const codex = permissionModeOptions("codex")[0];
    expect(codex?.description).toBe("Edits, repo commands run");
    expect(codex?.title).toBe(
      "File edits, and commands that stay inside the workspace, go through without asking.",
    );
    // An engine that cannot ask first is offered Bypass all alone.
    expect(permissionModeOptions("pi").map((row) => row.id)).toEqual(["bypass"]);
  });

  test("the rows follow the add menu's grammar: one line, the label then the muted description, a check on the selected row", () => {
    const html = renderToStaticMarkup(<PermissionModePanel mode="auto-accept-edits" onChange={() => {}} engine="codex" />);
    const rows = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
    expect(rows).toHaveLength(4);
    // The add menu's row: px-2.5 py-1, one line, regular 13px, the hover surface.
    for (const row of rows) expect(row).toContain("gap-2.5 rounded-2lg px-2.5 py-1 text-left text-body-2-regular text-text-primary");
    const auto = rows[0] ?? "";
    expect(auto).toContain('aria-checked="true"');
    expect(auto).toContain('title="File edits, and commands that stay inside the workspace, go through without asking."');
    // Every row carries its full sentence on its title.
    expect(rows[1]).toContain('title="Asks before running a command or changing a file."');
    // The selected surface as its own token, not the hover variant every row carries.
    expect(auto).toMatch(/[\s"]bg-background-primary-hover[\s"]/);
    expect(rows[1]).not.toMatch(/[\s"]bg-background-primary-hover[\s"]/);
    // Label then the inline muted description, which truncates on a narrow panel.
    expect(html).toContain('class="shrink-0 text-body-2-regular text-text-primary">Auto<');
    expect(html).toContain('class="truncate text-text-tertiary text-caption-1-regular">Edits, repo commands run<');
    expect(html).not.toContain("text-body-2-medium");
    expect(html).not.toContain("text-body-medium");
    // The trailing check marks the selected row alone.
    expect(html.match(/text-foreground-icon-primary/g)).toHaveLength(1);
    const checked = html.slice(html.indexOf('aria-checked="true"'), html.indexOf('aria-checked="false"'));
    expect(checked).toContain("text-foreground-icon-primary");
    // The popover is the panel's React Aria popover (nothing renders closed), so its
    // panel and header are read from the source: the add menu's w-72, 14px corners,
    // card shadow and text-mono-label header, with the add menu's divider before a hint.
    const panel = readFileSync(new URL("./composer-panel/composer-panel.tsx", import.meta.url), "utf8");
    const start = panel.indexOf("const PERMISSION_POPOVER");
    const popover = panel.slice(start, panel.indexOf("/* ----", start));
    expect(popover).toContain('"w-72 max-w-[calc(100vw-2rem)]"');
    expect(popover).toContain("rounded-[14px] border border-border-button-default bg-background-primary-default p-1.5 shadow-card");
    expect(popover).not.toContain("rounded-2xl");
    expect(popover).toContain('<p className="px-2.5 pb-0.5 pt-0.5 text-mono-label text-text-tertiary">Permissions</p>');
    expect(popover).toContain("<AddMenuDivider />");
  });
});

describe("permission mode panel", () => {
  test("offers the four rows and marks the current one", () => {
    const html = renderToStaticMarkup(<PermissionModePanel mode="approval-required" onChange={() => {}} />);
    expect(html.match(/role="radio"/g)).toHaveLength(4);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    const checked = html.slice(html.indexOf('aria-checked="true"'));
    expect(checked.indexOf("Manual")).toBeLessThan(checked.indexOf('aria-checked="false"'));
    expect(html).not.toContain(BYPASS_ONLY);
  });

  test("a stored operator posture reads as Auto, and Auto sends edits applied without asking", () => {
    const html = renderToStaticMarkup(<PermissionModePanel mode="auto" onChange={() => {}} />);
    const checked = html.slice(html.indexOf('aria-checked="true"'));
    expect(checked.indexOf("Auto")).toBeLessThan(checked.indexOf('aria-checked="false"'));
  });

  test("an engine that cannot ask first gets Bypass all alone, with the reason", () => {
    const html = renderToStaticMarkup(<PermissionModePanel mode="full-access" onChange={() => {}} engine="pi" />);
    expect(html.match(/role="radio"/g)).toHaveLength(1);
    expect(html).toContain("Bypass all");
    expect(html).toContain(BYPASS_ONLY);
    // One line under its row, the full sentence on the title, behind the add menu's divider.
    expect(html).toContain(`class="truncate px-2.5 py-1 text-caption-1-regular text-text-tertiary" title="${BYPASS_ONLY}"`);
    expect(html).toContain("my-1 border-t border-border-button-default");
    for (const hidden of ["Manual", "Plan mode", ">Auto<"]) expect(html).not.toContain(hidden);
  });
});

describe("permission mode chip and tag", () => {
  test("the chip names the current face, and holds still while a question resumes the running turn", () => {
    const live = renderToStaticMarkup(<PermissionModeChip mode="approval-required" onChange={() => {}} />);
    expect(live).toContain('aria-label="Permission: Manual"');
    expect(live).not.toContain('disabled=""');
    const held = renderToStaticMarkup(<PermissionModeChip mode="read-only" onChange={() => {}} disabled />);
    expect(held).toContain('aria-label="Permission: Plan mode"');
    expect(held).toContain('disabled=""');
    // The chip is the model chip's box (h-8) and size (13px), not the panel's 30px and 14px,
    // and the popover's header is 13px too (read from the source: nothing renders closed).
    expect(live).toContain("h-8 ");
    expect(live).not.toContain("h-[30px]");
    expect(live).toContain('class="text-body-2-medium whitespace-nowrap text-text-secondary">Manual<');
    const panel = readFileSync(new URL("./composer-panel/composer-panel.tsx", import.meta.url), "utf8");
    // Only the permission markup is held to 13px; the panel's other pieces keep their own sizes.
    const start = panel.indexOf("export type ComposerPermission");
    const permission = panel.slice(start, panel.indexOf("/* ----", start));
    expect(permission).toContain("export function PermissionMenu(");
    expect(permission).not.toContain("text-body-medium");
  });

  test("the tag replays the face under a message", () => {
    const tag = renderToStaticMarkup(<PermissionModeTag mode="auto-accept-edits" />);
    expect(tag).toContain('data-testid="permission-mode-tag"');
    expect(tag).toContain("Auto");
    expect(renderToStaticMarkup(<PermissionModeTag mode="full-access" />)).toContain("Bypass all");
    expect(renderToStaticMarkup(<PermissionModeTag mode="read-only" />)).toContain("Plan mode");
    expect(renderToStaticMarkup(<PermissionModeTag mode={undefined} />)).toBe("");
  });

  test("the new-task composer sends the pick only when the selected engine can honour it, from its footer", () => {
    // The composer owns a router and a capability catalog, so its wiring is read, not rendered.
    const composer = readFileSync(
      new URL("../../app/(workspace)/agent/new/new-task-composer.tsx", import.meta.url),
      "utf8",
    );
    expect(composer).toContain('import { permissionModeFor } from "@/components/chat/permission-mode";');
    expect(composer).toContain("const permissionMode = permissionModeFor(engine, chosenMode);");
    expect(composer).toContain("permission_mode: permissionMode,");
    expect(composer).toContain("onChange={setChosenMode}");
    expect(composer).toContain("engine={engine}");
    // The chip sits in the footer between the add button and the engine chip, not in the notch.
    const footer = composer.slice(composer.indexOf("<ComposerAddButton"), composer.indexOf("{submitting ? ("));
    expect(footer).toContain("<PermissionModeChip");
    // The footer is 13px throughout: the model trigger beside the chip reads at body-2 too.
    const picker = composer.slice(composer.indexOf("<ModelPicker"), composer.indexOf("/>", composer.indexOf("<ModelPicker")));
    expect(picker).toContain("h-8 min-w-0 max-w-[16rem] rounded-full px-2.5 text-body-2-medium text-text-secondary");
    expect(picker).not.toContain("text-caption-1-medium");
  });
});
