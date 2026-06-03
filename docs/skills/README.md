# Skills (docs)

Versioned SKILL.md source that agents can read directly or import into the
product's skills catalog (frontmatter `name` + `description`, then
`## Overview` / `## Procedure` / `## Verify`, matching `backend/src/skills`).

- [task-convention](task-convention/SKILL.md) - use the durable, org-scoped task
  manager for multi-step work, with `.useagent/tasks.md` as an explicit
  repo-local or offline fallback.
