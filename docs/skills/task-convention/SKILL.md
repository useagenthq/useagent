---
name: Task Convention
description: Track multi-step, multi-run, or multi-agent work in one git-versioned markdown file (.useagent/tasks.md) that every harness reads and writes.
---

# Task Convention

Track multi-step, multi-run, or multi-agent work in one git-versioned markdown file (.useagent/tasks.md) that every harness reads and writes.

## Overview

- Trigger: use this whenever a task spans multiple steps, spans multiple runs, or is worked on by more than one agent (Claude, Codex, OpenCode, Pi). For a single quick edit you do not need it.
- The shared source of truth is one file at the repo root: `.useagent/tasks.md`. Every harness reads and writes the SAME file, so it is the zero-infra task manager across agents and runs. There is no server and no protocol to learn.
- Why a markdown file and not an MCP task server: the file is durable across sessions and agents, it is git-versioned (history, review, blame, rollback come for free), it needs zero infrastructure, and every harness can read and edit it with plain file tools. An MCP task server is process-scoped, needs a running service, and is invisible to any agent that does not speak its protocol, so state is lost the moment the process or the harness changes.
- Because it lives in git next to the code, the task list travels with the branch: a reviewer sees what was planned and what shipped in the same diff.

## Procedure

1. Read `.useagent/tasks.md` first, before you plan. It tells you what is already in flight and what another agent may have claimed. If the file does not exist, create it with the skeleton below.
2. Use four sections: `## Todo`, `## In progress`, `## Done`, and an append-only `## Log`.
3. Write each task as one line: `- [ ] <id>: <desc>` where `<id>` is a short slug (for example `auth-retry`) and `<desc>` is a plain one-line description. One task per line.
4. Move a task line between sections as its state changes: `## Todo` to `## In progress` to `## Done`. When a task is finished, mark it `- [x]` and place it under `## Done`.
5. Update the file as you finish each step, not only at the end. A tracker that is only correct at the end is worse than none, because other agents read it mid-run.
6. Append a date-stamped one-liner to `## Log` for each notable change (a task split, a blocker, a decision). Never rewrite or delete past log lines; the log is history.
7. Commit `.useagent/tasks.md` together with the code changes it describes, so task state and work land in the same git history.
8. Every agent uses this identical file. Never invent a parallel tracker (a second file, an in-memory list, a scratch note, or an MCP task board); a second tracker splits the source of truth and the harnesses drift apart.

Skeleton for a new `.useagent/tasks.md` (each line below is the literal file content):

    # Tasks

    ## Todo
    - [ ] example-id: short description of the task

    ## In progress

    ## Done

    ## Log
    - 2026-01-01: created tasks file

## Verify

- `.useagent/tasks.md` exists at the repo root and has `## Todo`, `## In progress`, `## Done`, and `## Log` sections.
- Every task line matches `- [ ] <id>: <desc>` (or `- [x]` when done), with a short slug id.
- The file reflects the current state: steps you already finished are under `## Done`, not still under `## Todo`.
- The `## Log` has at least one date-stamped line and no past lines were rewritten.
- The file change is committed alongside the related code change.
- No parallel tracker exists; this file is the only task list for the repo.
