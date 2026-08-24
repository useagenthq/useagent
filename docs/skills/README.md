# Skills (docs)

Versioned SKILL.md source that agents can read directly or import into the
product's skills catalog (frontmatter `name` + `description`, then
`## Overview` / `## Procedure` / `## Verify`, matching `backend/src/skills`).

- [task-convention](task-convention/SKILL.md) - track multi-step, multi-run, or
  cross-agent work in one git-versioned `.useagent/tasks.md` that every harness
  reads and writes.
