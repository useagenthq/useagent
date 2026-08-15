export const BLUEPRINT_DEFAULT_LIMIT = 10;
export const BLUEPRINT_MAX_LIMIT = 25;

export const BLUEPRINT_TOOLS = [
  {
    name: "blueprint_list",
    description:
      "List bounded, versioned environment blueprints available to this organization. " +
      "Blueprints are reference plans stored on the existing playbook substrate; listing never executes setup commands.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: BLUEPRINT_MAX_LIMIT },
      },
      additionalProperties: false,
    },
  },
  {
    name: "blueprint_get",
    description:
      "Read one exact immutable blueprint revision from blueprint_list. Identity comes from the signed capability.",
    inputSchema: {
      type: "object",
      properties: {
        blueprintId: { type: "string" },
        version: { type: "integer", minimum: 1 },
      },
      required: ["blueprintId"],
      additionalProperties: false,
    },
  },
  {
    name: "blueprint_validate",
    description:
      "Validate that an exact blueprint revision is structurally usable for a target repository. " +
      "Returns errors and warnings only; it never executes the blueprint.",
    inputSchema: {
      type: "object",
      properties: {
        blueprintId: { type: "string" },
        version: { type: "integer", minimum: 1 },
        repository: {
          type: "string",
          description: "Exact owner/repository target the caller intends to configure.",
        },
      },
      required: ["blueprintId", "repository"],
      additionalProperties: false,
    },
  },
  {
    name: "blueprint_apply_plan",
    description:
      "Create a non-executing, immutable application plan for one validated blueprint and target repository. " +
      "The result pins blueprint id, version, and content hash; commands remain reference data for a later sandbox task.",
    inputSchema: {
      type: "object",
      properties: {
        blueprintId: { type: "string" },
        version: { type: "integer", minimum: 1 },
        repository: { type: "string" },
      },
      required: ["blueprintId", "repository"],
      additionalProperties: false,
    },
  },
] as const;

export const BLUEPRINT_TOOL_NAMES: ReadonlySet<string> = new Set(
  BLUEPRINT_TOOLS.map((tool) => tool.name),
);
