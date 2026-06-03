---
name: Task Convention
description: Track multi-step work in useAgent's durable task manager, with .useagent/tasks.md as an explicit repo-local or offline fallback.
---

# Task Convention

Track multi-step, multi-run, or multi-agent work without creating competing sources of truth.

## Overview

- Trigger this skill when work spans multiple steps, runs, or agents. A single quick edit does not need a task plan.
- When the `task_create`, `task_list`, and `task_update` tools are available, useAgent's org-scoped durable task manager is authoritative. It survives sessions, supports project and unfiled work, and is shared across harnesses.
- Use `.useagent/tasks.md` only when the user explicitly wants a git-versioned repo-local plan, when durable task tools are unavailable, or while working offline.
- Do not silently maintain both stores. When both are required, declare which is authoritative and synchronize only at explicit handoff points.

## Procedure

1. Discover the available task tools before planning. Do not guess their arguments.
2. If durable task tools are available, list existing tasks for the current project or unfiled scope before creating new ones.
3. Create one task per independently verifiable outcome. Update its status as work moves from todo to in progress to done or archived.
4. Preserve independent work: a task without a project stays unfiled rather than inventing a project name.
5. If the user requests a repo-local plan, or durable tools are unavailable, use `.useagent/tasks.md` with `## Todo`, `## In progress`, `## Done`, and append-only `## Log` sections.
6. In the markdown fallback, write tasks as `- [ ] <id>: <description>`, move them between sections, and append date-stamped decisions or blockers to the log.
7. When reconnecting after offline work, read the durable task state first. Reconcile the markdown file explicitly, recording the synchronization in its log; never overwrite newer durable state silently.
8. Commit `.useagent/tasks.md` with the code changes it describes when the file is used.

Fallback skeleton:

    # Tasks

    ## Todo
    - [ ] example-id: short description of the task

    ## In progress

    ## Done

    ## Log
    - 2026-01-01: created tasks file

## Verify

- Durable task tools were preferred when available, and all mutations used the current org-scoped tool context.
- Unfiled work remained unfiled unless the user or an existing binding selected a project.
- If `.useagent/tasks.md` was used, it contains the four required sections and reflects current work accurately.
- No hidden second tracker was created.
- If both stores were required, the response names the authoritative store and the reconciliation point is recorded.
