// ---------------------------------------------------------------------------
// Read-only GitHub tool family: PR + issue visibility for sandboxed agents.
// The sandbox previously could clone a bound repo but had NO way to see its
// pull requests or issues, so agents improvised from `git log`. These tools
// close that gap: the trusted gateway calls api.github.com server-side with
// the org's App/PAT credential (never exposed to the sandbox) and returns
// bounded JSON summaries scoped to the RUN's bound repositories only.
// ---------------------------------------------------------------------------

const REPO_PROPERTY = {
  type: "string",
  description:
    "Repository full name (owner/name). Must be one of the repositories bound to this run.",
} as const;

const STATE_PROPERTY = {
  type: "string",
  enum: ["open", "closed", "all"],
  description: "Filter by state. Defaults to open.",
} as const;

const LIMIT_PROPERTY = {
  type: "integer",
  minimum: 1,
  maximum: 50,
  description: "Maximum results to return. Defaults to 20, capped at 50.",
} as const;

export const GITHUB_TOOLS = [
  {
    name: "github_list_prs",
    description:
      "List pull requests for one of this run's bound GitHub repositories, newest activity first. " +
      "Read-only: the trusted gateway calls GitHub server-side and credentials never reach the sandbox. " +
      "Returns a bounded summary per PR (number, title, state, author, branches).",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROPERTY,
        state: STATE_PROPERTY,
        limit: LIMIT_PROPERTY,
      },
      required: ["repo"],
      additionalProperties: false,
    },
  },
  {
    name: "github_pr_detail",
    description:
      "Read one pull request from a bound repository: title, body, author, branches, merge state, " +
      "counts, and a bounded files-changed summary. Read-only server-side call; credentials never " +
      "reach the sandbox and long bodies or file lists are truncated with explicit markers.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROPERTY,
        number: {
          type: "integer",
          minimum: 1,
          description: "Pull request number.",
        },
      },
      required: ["repo", "number"],
      additionalProperties: false,
    },
  },
  {
    name: "github_list_issues",
    description:
      "List issues for one of this run's bound GitHub repositories, newest activity first. " +
      "Pull requests are excluded. Read-only server-side call returning a bounded summary per " +
      "issue (number, title, state, author, labels, comment count).",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROPERTY,
        state: STATE_PROPERTY,
        limit: LIMIT_PROPERTY,
      },
      required: ["repo"],
      additionalProperties: false,
    },
  },
] as const;

export const GITHUB_TOOL_NAMES: ReadonlySet<string> = new Set(
  GITHUB_TOOLS.map((tool) => tool.name),
);
