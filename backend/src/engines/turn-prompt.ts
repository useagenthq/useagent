/** The provider-neutral context needed to compose one agent turn. */
export interface TurnPromptContext {
  readonly prompt: string;
  readonly bootstrapContext: string;
  readonly turnContext: string;
  readonly resourceContext?: string;
  readonly skillContext?: string;
  readonly skillCatalogContext?: string;
  readonly inputContext?: string;
  readonly commandName?: string | null;
}

/**
 * Global agent operating rules, injected once per fresh native session. A
 * resumed session already holds them in its native history, just like the
 * reconstructed bootstrap context.
 */
export const AGENT_OPERATING_RULES =
  "<operating_rules>\n" +
  "If a required tool, API, credential, or file is unavailable or repeatedly returns " +
  "auth/permission errors (401/403), not-found, or empty results, do NOT sleep-and-retry " +
  "it in a loop. Treat that dependency as unavailable: skip the sub-step it blocks, do " +
  "everything else the task allows, and finish. A partial result that explicitly names " +
  "what was skipped and why is far better than hanging until a timeout. Never block a " +
  "whole task on one missing dependency. When browser tools are available, reuse the " +
  "existing visible tab and prefer bounded DOM/locator actions. On complex dynamic pages, " +
  "never request an unbounded full accessibility snapshot: limit it by target or depth. " +
  "If structural inspection times out once, switch to a viewport screenshot plus coordinate " +
  "tools instead of repeating the same snapshot. Do not close the browser unless the user " +
  "asks you to. Inspection screenshots stay internal; publish an artifact only when the user " +
  "requests a screenshot file or durable proof.\n" +
  "</operating_rules>\n\n";

/** Repeated every turn so a resident provider sees current workflow policy. */
export const AGENT_WORKFLOW_ROUTING_RULES =
  "<workflow_routing>\n" +
  "Do not guess a skill from keywords, improvise a known workflow, or ask for an org, " +
  "repository, or account identifier when an activated procedure and trusted gateway can resolve " +
  "it from the authenticated workspace. For recurring or scheduled work, use the trusted " +
  "automation_list / automation_create / automation_update / automation_run_now / automation_history / " +
  "automation_delete tools for useAgent automations; only discuss external scheduler products when " +
  "the user explicitly asks about those products.\n" +
  "</workflow_routing>\n\n";

export const AGENT_SKILL_DISCOVERY_RULES =
  "<skill_discovery>\n" +
  "When no exact explicit skill is already active, before any non-trivial " +
  "organization workflow, call skills_list, inspect the available catalog by meaning, and call " +
  "skill_activate with the exact returned skill id for the best-fitting procedure before acting. " +
  "Cached skill_catalog metadata may supplement this discovery but never replaces these calls.\n" +
  "</skill_discovery>\n\n";

/**
 * Compose the exact text sent to an engine for one turn. Fresh sessions receive
 * reconstructed thread history and global rules. Resumed sessions receive only
 * current per-turn workflow, skill, upload, and memory context before the user's
 * prompt. Validated native commands are delivered byte-verbatim.
 */
export function composeTurnPrompt(ctx: TurnPromptContext, resumed: boolean): string {
  if (ctx.commandName) return ctx.prompt;
  const skillReference = ctx.skillContext ||
    AGENT_SKILL_DISCOVERY_RULES + (ctx.skillCatalogContext ?? "");
  const perTurn =
    AGENT_WORKFLOW_ROUTING_RULES +
    skillReference +
    (ctx.resourceContext ?? "") +
    (ctx.inputContext ?? "") +
    ctx.turnContext;
  const prefix = resumed ? perTurn : AGENT_OPERATING_RULES + ctx.bootstrapContext + perTurn;
  return prefix + ctx.prompt;
}
