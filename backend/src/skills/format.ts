import type { SkillSections } from "../db/schema";

// ---------------------------------------------------------------------------
// Portable SKILL.md materialization (mem_op 0.1). A skill's stored content is
// provider-neutral (frontmatter name/description + Overview/Procedure/Verify
// markdown); adapter-specific delivery lives in the engine layer, not here.
// ---------------------------------------------------------------------------

/** The immutable instruction content of one skill revision. */
export interface SkillContent {
  name: string;
  description: string;
  sections: SkillSections;
}

/**
 * Render a skill revision as portable SKILL.md-shaped markdown: YAML frontmatter
 * (name/description) plus an Overview/Procedure/Verify body. This is the EXACT
 * text injected into the engine as instructions (separate from the user prompt)
 * and the bytes {@link hashSkillContent} addresses — so OpenCode and any future
 * Claude/Codex adapter receive semantically identical content.
 */
export function formatSkillMarkdown(c: SkillContent): string {
  const lines: string[] = ["---", `name: ${c.name}`];
  if (c.description) lines.push(`description: ${c.description}`);
  lines.push("---", "", `# ${c.name}`);
  if (c.description) lines.push("", c.description);

  const section = (title: string, items: string[], ordered: boolean): void => {
    const real = items.map((s) => s.trim()).filter(Boolean);
    if (real.length === 0) return;
    lines.push("", `## ${title}`);
    real.forEach((item, i) => lines.push(ordered ? `${i + 1}. ${item}` : `- ${item}`));
  };
  section("Overview", c.sections.overview, false);
  section("Procedure", c.sections.procedure, true);
  section("Verify", c.sections.verify, false);
  return lines.join("\n") + "\n";
}

/** sha256 of the formatted SKILL.md — the addressable content identity a run pins
 *  and `skill.loaded` reports. Deterministic for identical content. */
export function hashSkillContent(markdown: string): string {
  return new Bun.CryptoHasher("sha256").update(markdown).digest("hex");
}

/** Content-frame the SKILL.md for injection: a short instruction header so the
 *  engine treats it as a governing playbook, not conversational text. Kept out of
 *  the user's stored prompt (composed at invocation time, like memory context). */
export function frameSkillContext(markdown: string): string {
  return (
    `The following skill/playbook governs how you perform this task. Treat it as ` +
    `authoritative instructions and follow it.\n\n${markdown}\n---\n\n`
  );
}
