import type { SkillSections } from "../../db/schema";
import {
  getSkillForOrg,
  listSkillCatalogForOrg,
  resolveSkillSelection,
} from "../../skills/repo";
import type { ToolTokenClaims } from "./token";
import type { ToolCallResult } from "./tools";
import { errorResult, textResult } from "./tool-results";
import {
  BLUEPRINT_DEFAULT_LIMIT,
  BLUEPRINT_MAX_LIMIT,
} from "./blueprint-tool-catalog";

const BLUEPRINT_TAG = "blueprint";
const MAX_BLUEPRINT_PREVIEW_CHARS = 8_000;
const MAX_PLAN_SECTION_CHARS = 6_000;
const MAX_PLAN_SECTION_LINES = 80;
const MAX_REPOSITORY_CHARS = 240;

export { BLUEPRINT_TOOL_NAMES, BLUEPRINT_TOOLS } from "./blueprint-tool-catalog";

interface BlueprintRevision {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly contentHash: string;
  readonly sections: SkillSections;
  readonly sourceRepo: string | null;
  readonly sourcePath: string | null;
  readonly yaml: string;
}

interface BoundedLines {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(BLUEPRINT_MAX_LIMIT, Math.max(1, value))
    : BLUEPRINT_DEFAULT_LIMIT;
}

function extractYaml(lines: readonly string[]): string {
  const start = lines.findIndex((line) => line.trim().toLowerCase() === "```yaml");
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && line.trim() === "```");
  if (end < 0) return "";
  return lines.slice(start + 1, end).join("\n").trim();
}

function boundLines(lines: readonly string[]): BoundedLines {
  const bounded: string[] = [];
  let usedChars = 0;
  for (const line of lines) {
    if (bounded.length >= MAX_PLAN_SECTION_LINES) {
      return { lines: bounded, truncated: true };
    }
    const separatorChars = bounded.length > 0 ? 1 : 0;
    const remainingChars = MAX_PLAN_SECTION_CHARS - usedChars - separatorChars;
    if (remainingChars <= 0) return { lines: bounded, truncated: true };
    if (line.length > remainingChars) {
      bounded.push(line.slice(0, remainingChars));
      return { lines: bounded, truncated: true };
    }
    bounded.push(line);
    usedChars += separatorChars + line.length;
  }
  return { lines: bounded, truncated: false };
}

function contentRef(blueprint: Pick<BlueprintRevision, "id" | "version">): string {
  return `blueprint:${blueprint.id}@${blueprint.version}`;
}

function expectedRepository(name: string): string | null {
  const value = name.replace(/^Blueprint:\s*/i, "").trim();
  return value.includes("/") ? value : null;
}

function validateRevision(
  blueprint: BlueprintRevision,
  repository: string,
): { readonly valid: boolean; readonly errors: readonly string[]; readonly warnings: readonly string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!blueprint.yaml) errors.push("Blueprint revision has no complete fenced YAML payload.");
  if (!blueprint.sections.overview.some((line) => /sandbox/i.test(line))) {
    errors.push("Blueprint revision is missing its sandbox-only safety boundary.");
  }
  if (!blueprint.sections.verify.length) {
    errors.push("Blueprint revision has no verification contract.");
  }
  const expected = expectedRepository(blueprint.name);
  if (expected && expected.toLowerCase() !== repository.toLowerCase()) {
    errors.push(`Blueprint targets ${expected}, not ${repository}.`);
  }
  if (!blueprint.sourcePath) warnings.push("Blueprint has no source path provenance.");
  if (!blueprint.sourceRepo) warnings.push("Blueprint has no source repository provenance.");
  return { valid: errors.length === 0, errors, warnings };
}

async function resolveBlueprint(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<BlueprintRevision | ToolCallResult> {
  const id = cleanString(args.blueprintId);
  if (!id) return errorResult("An exact blueprintId from blueprint_list is required.", { status: 400 });
  if (!isUuid(id)) return errorResult("Blueprint was not found in this organization.", { status: 404 });
  const row = await getSkillForOrg(claims.orgId, id);
  if (!row || row.kind !== "playbook" || !row.tags.includes(BLUEPRINT_TAG)) {
    return errorResult("Blueprint was not found in this organization.", { status: 404 });
  }
  const revision = await resolveSkillSelection(claims.orgId, {
    id,
    version: cleanVersion(args.version),
  });
  if (!revision) return errorResult("Blueprint revision was not found.", { status: 404 });
  return {
    id,
    version: revision.version,
    name: revision.content.name,
    description: revision.content.description,
    contentHash: revision.contentHash,
    sections: revision.content.sections,
    sourceRepo: row.sourceRepo,
    sourcePath: row.sourcePath,
    yaml: extractYaml(revision.content.sections.procedure),
  };
}

function isToolCallResult(value: BlueprintRevision | ToolCallResult): value is ToolCallResult {
  return Array.isArray((value as ToolCallResult).content);
}

async function listBlueprints(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const limit = boundedLimit(args.limit);
  const entries = (await listSkillCatalogForOrg(claims.orgId))
    .filter((entry) => entry.kind === "playbook" && entry.tags.includes(BLUEPRINT_TAG));
  const blueprints = entries.slice(0, limit).map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    version: entry.currentVersion,
  }));
  return textResult(
    blueprints.length
      ? blueprints.map((blueprint) => `[${blueprint.id}] ${blueprint.name} (v${blueprint.version})`).join("\n")
      : "No environment blueprints are available to this organization.",
    { blueprints, truncated: entries.length > blueprints.length },
  );
}

async function getBlueprint(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const blueprint = await resolveBlueprint(claims, args);
  if (isToolCallResult(blueprint)) return blueprint;
  const yaml = blueprint.yaml.slice(0, MAX_BLUEPRINT_PREVIEW_CHARS);
  const truncated = yaml.length < blueprint.yaml.length;
  const view = {
    id: blueprint.id,
    version: blueprint.version,
    name: blueprint.name,
    description: blueprint.description,
    contentHash: blueprint.contentHash,
    contentRef: contentRef(blueprint),
    sourceRepo: blueprint.sourceRepo,
    sourcePath: blueprint.sourcePath,
    yaml,
    truncated,
  };
  return textResult(`# ${blueprint.name}\n\n${yaml}`, { blueprint: view });
}

async function validateBlueprint(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const repository = cleanString(args.repository);
  if (!repository || repository.length > MAX_REPOSITORY_CHARS || !repository.includes("/")) {
    return errorResult("repository must be an exact owner/repository value.", { status: 400 });
  }
  const blueprint = await resolveBlueprint(claims, args);
  if (isToolCallResult(blueprint)) return blueprint;
  const validation = validateRevision(blueprint, repository);
  return {
    ...textResult(
      validation.valid
        ? `Blueprint ${blueprint.id}@${blueprint.version} is valid for ${repository}.`
        : `Blueprint ${blueprint.id}@${blueprint.version} is not valid for ${repository}: ${validation.errors.join(" ")}`,
      { blueprintId: blueprint.id, version: blueprint.version, repository, ...validation },
    ),
    ...(validation.valid ? {} : { isError: true }),
  };
}

async function applyPlan(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const repository = cleanString(args.repository);
  if (!repository || repository.length > MAX_REPOSITORY_CHARS || !repository.includes("/")) {
    return errorResult("repository must be an exact owner/repository value.", { status: 400 });
  }
  const blueprint = await resolveBlueprint(claims, args);
  if (isToolCallResult(blueprint)) return blueprint;
  const validation = validateRevision(blueprint, repository);
  if (!validation.valid) {
    return errorResult("Blueprint must pass blueprint_validate before an application plan can be created.", {
      blueprintId: blueprint.id,
      version: blueprint.version,
      repository,
      ...validation,
    });
  }
  const procedure = boundLines(
    blueprint.sections.procedure.filter((line) => !line.startsWith("```")),
  );
  const verify = boundLines(blueprint.sections.verify);
  const plan = {
    repository,
    blueprint: {
      id: blueprint.id,
      version: blueprint.version,
      contentHash: blueprint.contentHash,
      contentRef: contentRef(blueprint),
      sourceRepo: blueprint.sourceRepo,
      sourcePath: blueprint.sourcePath,
    },
    sandboxOnly: true,
    executed: false,
    procedure: procedure.lines,
    verify: verify.lines,
    truncated: procedure.truncated || verify.truncated,
  };
  return textResult(
    `Prepared a non-executing sandbox application plan for ${repository} from ${blueprint.id}@${blueprint.version}.`,
    { plan },
  );
}

export async function executeBlueprintTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (name === "blueprint_list") return listBlueprints(claims, args);
  if (name === "blueprint_get") return getBlueprint(claims, args);
  if (name === "blueprint_validate") return validateBlueprint(claims, args);
  if (name === "blueprint_apply_plan") return applyPlan(claims, args);
  return errorResult(`Unknown tool: ${name}`);
}
