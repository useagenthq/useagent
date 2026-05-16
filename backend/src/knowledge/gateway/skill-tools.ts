import type { ToolTokenClaims } from "./token";
import type { ToolCallResult } from "./tools";
import { formatSkillMarkdown } from "../../skills/format";
import {
  bumpSkillUsage,
  listSkillCatalogForOrg,
  resolveSkillSelection,
} from "../../skills/repo";
import { pinSkillToActiveRun } from "../../runs/repo";
import { recordSkillLoaded } from "../../skills/skill-loaded";

const DEFAULT_CATALOG_PAGE_SIZE = 50;
const MAX_CATALOG_PAGE_SIZE = 100;
const MAX_DESCRIPTION_CHARS = 500;

export const SKILL_TOOLS = [
  {
    name: "skills_list",
    description:
      "List this organization's available skills and playbooks with their descriptions. " +
      "Use this before a non-trivial or recurring workflow, choose by semantic fit, then " +
      "call skill_activate with the selected id. The gateway performs no keyword routing.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "integer",
          minimum: 0,
          description: "Zero-based catalog offset returned as nextCursor by the previous page.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_CATALOG_PAGE_SIZE,
          description: `Entries per page (default ${DEFAULT_CATALOG_PAGE_SIZE}, max ${MAX_CATALOG_PAGE_SIZE}).`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "skill_activate",
    description:
      "Activate the current immutable revision of one skill or playbook from skills_list " +
      "for this running turn. Returns its full authoritative instructions and records the " +
      "load in the timeline. Call this before following the procedure or using a tool guarded by it.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "Exact skill id returned by skills_list." },
      },
      required: ["skillId"],
      additionalProperties: false,
    },
  },
] as const;

export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set(SKILL_TOOLS.map((tool) => tool.name));

function error(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

async function listSkills(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const cursor = boundedInteger(args.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(
    args.limit,
    DEFAULT_CATALOG_PAGE_SIZE,
    1,
    MAX_CATALOG_PAGE_SIZE,
  );
  const entries = await listSkillCatalogForOrg(claims.orgId);
  const catalog = entries
    .slice(cursor, cursor + limit)
    .map((entry) => ({
      ...entry,
      description: entry.description.slice(0, MAX_DESCRIPTION_CHARS),
    }));
  const text = catalog.length === 0
    ? "No skills or playbooks are available to this organization."
    : catalog
        .map(
          (entry) =>
            `[${entry.id}] ${entry.kind}: ${entry.name} (v${entry.currentVersion})\n` +
            `${entry.description || "No description."}` +
            `${entry.tags.length > 0 ? `\nTags: ${entry.tags.join(", ")}` : ""}`,
        )
        .join("\n\n");
  const nextCursor = cursor + catalog.length < entries.length ? cursor + catalog.length : null;
  return {
    content: [{ type: "text", text }],
    structuredContent: { skills: catalog, nextCursor },
  };
}

async function activateSkill(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const skillId = typeof args.skillId === "string" ? args.skillId.trim() : "";
  if (!skillId) return error("skill_activate requires an exact `skillId` from skills_list.");

  const pinned = await resolveSkillSelection(claims.orgId, { id: skillId });
  if (!pinned) return error("That skill is not available to this organization.");
  const activated = await pinSkillToActiveRun({
    runId: claims.runId,
    threadId: claims.threadId,
    orgId: claims.orgId,
    skillId: pinned.skillId,
    skillVersion: pinned.version,
    skillContentHash: pinned.contentHash,
  });
  if (!activated) return error("The skill can only be activated for the current running turn.");

  const markdown = formatSkillMarkdown(pinned.content);
  await Promise.all([
    bumpSkillUsage(claims.orgId, pinned.skillId),
    recordSkillLoaded(claims.runId, claims.threadId, {
      skillId: pinned.skillId,
      version: pinned.version,
      kind: pinned.kind,
      name: pinned.content.name,
      contentHash: pinned.contentHash,
      source: "skill",
      contentChars: markdown.length,
    }),
  ]);

  return {
    content: [
      {
        type: "text",
        text:
          "The following skill/playbook now governs this turn. Treat it as authoritative " +
          `instructions and follow it.\n\n${markdown}`,
      },
    ],
    structuredContent: {
      skillId: pinned.skillId,
      version: pinned.version,
      kind: pinned.kind,
      name: pinned.content.name,
      contentHash: pinned.contentHash,
    },
  };
}

export async function executeSkillTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (name === "skills_list") return listSkills(claims, args);
  if (name === "skill_activate") return activateSkill(claims, args);
  return error(`Unknown tool: ${name}`);
}
