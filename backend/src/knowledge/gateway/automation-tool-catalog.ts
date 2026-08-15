export const AUTOMATION_TOOLS = [
  {
    name: "automation_schema",
    description:
      "Describe the provider-neutral Skynet automation contract and safety gates. Use this before creating or editing an automation when field support is unclear.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "automation_list",
    description:
      "List this organization's Skynet scheduled automations. Use this for user requests about existing automations or recurring tasks. Identity is taken only from the gateway token.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "automation_get",
    description:
      "Get one Skynet scheduled automation summary by id. Identity is taken only from the gateway token; full prompt bodies are not returned to the model.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Automation id returned by automation_list/create." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "automation_create",
    description:
      "Create a Skynet scheduled automation in this organization. New automations are always created disabled and never auto-run until automation_update enables them. Engine and model default to the current run when omitted. Use this for workspace recurring-task requests.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable automation name." },
        cron: { type: "string", description: "Five-field cron expression." },
        timezone: { type: "string", description: "Optional IANA timezone, for example Asia/Kolkata." },
        prompt: { type: "string", description: "Prompt to run when the automation fires." },
        engine: { type: "string", description: "Optional Skynet engine id." },
        model: { type: "string", description: "Optional model id allowed for the selected engine." },
        skill: {
          type: ["object", "null"],
          description: "Optional org-scoped skill/playbook pin: { id, version? }. Omit for no pin.",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            version: { type: "number" },
          },
          required: ["id"],
        },
        repos: {
          type: "array",
          description: "Optional validated repository refs for the scheduled run.",
          items: { type: "string" },
        },
        tags: { type: "array", items: { type: "string" } },
        delivery: { type: ["object", "null"], additionalProperties: true },
        notifications: { type: ["object", "null"], additionalProperties: true },
        concurrency: { type: ["object", "null"], additionalProperties: true },
        queue: { type: ["object", "null"], additionalProperties: true },
        costLimits: { type: ["object", "null"], additionalProperties: true },
        frequencyLimits: { type: ["object", "null"], additionalProperties: true },
        approvalPolicy: { type: ["object", "null"], additionalProperties: true },
        enablementPolicy: { type: ["object", "null"], additionalProperties: true },
      },
      required: ["name", "cron", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "automation_update",
    description:
      "Update one existing Skynet automation in this organization. To set enabled=true, the user must have explicitly asked to enable or activate the automation and confirmEnable must be true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Automation id returned by automation_list/create." },
        name: { type: "string" },
        cron: { type: "string" },
        timezone: { type: ["string", "null"], description: "IANA timezone, or null/empty string to clear." },
        prompt: { type: "string" },
        engine: { type: "string" },
        model: { type: "string" },
        skill: {
          type: ["object", "null"],
          description: "Optional org-scoped skill/playbook pin: { id, version? }; null clears it.",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            version: { type: "number" },
          },
        },
        repos: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        delivery: { type: ["object", "null"], additionalProperties: true },
        notifications: { type: ["object", "null"], additionalProperties: true },
        concurrency: { type: ["object", "null"], additionalProperties: true },
        queue: { type: ["object", "null"], additionalProperties: true },
        costLimits: { type: ["object", "null"], additionalProperties: true },
        frequencyLimits: { type: ["object", "null"], additionalProperties: true },
        approvalPolicy: { type: ["object", "null"], additionalProperties: true },
        enablementPolicy: { type: ["object", "null"], additionalProperties: true },
        enabled: { type: "boolean" },
        confirmEnable: {
          type: "boolean",
          description: "Required true only when enabling after an explicit user request.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "automation_run_now",
    description:
      "Manually run one existing Skynet automation now. This creates a durable run and records a manual firing in the automation history.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Automation id returned by automation_list/create." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "automation_history",
    description:
      "Read firing history for one Skynet automation in this organization, including linked run status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Automation id returned by automation_list/create." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "automation_delete",
    description:
      "Delete one Skynet automation in this organization and its firing projection rows. Use for cleanup of test or obsolete automations.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Automation id returned by automation_list/create." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
] as const;

export const AUTOMATION_TOOL_NAMES: ReadonlySet<string> = new Set(
  AUTOMATION_TOOLS.map((tool) => tool.name),
);

export const AUTOMATION_CONTRACT = {
  version: "r10",
  identity: "org_id, user_id, thread_id, and run_id are derived only from the signed gateway capability",
  create: "always disabled; enabled is rejected on automation_create",
  enable: "requires enabled=true and confirmEnable=true; engine/model and required integrations are checked before enabling",
  execution: "scheduled runs carry typed repos and pinned skill/playbook references separately from the prompt",
  promptOutput: "tool responses return bounded summaries and prompt previews, not full prompt bodies",
  fields: {
    required: ["name", "cron", "prompt"],
    optional: [
      "timezone",
      "engine",
      "model",
      "skill",
      "repos",
      "tags",
      "delivery",
      "notifications",
      "concurrency",
      "queue",
      "costLimits",
      "frequencyLimits",
      "approvalPolicy",
      "enablementPolicy",
    ],
    serverDerived: ["org_id", "user_id", "run_actor_id"],
  },
} as const;
