# useAgent - AGENTS.md

Repository-wide instructions for coding agents. Read [`CLAUDE.md`](./CLAUDE.md)
before changing the repository; its hard rules apply to every agent and tool.

## Native harness invariant

Codex, Claude Code, OpenCode, and Pi always run through their provider-native
engine driver, protocol, session identity, lifecycle, and event grammar. A
sandbox choice such as Cube, Daytona, or Box changes only the execution
substrate. It must not select ACP or change resume, cancel, approvals,
questions, child events, or canonical projection semantics.

ACP is reserved for an explicitly registered future compatibility engine that
does not have a native driver. It is never a fallback for the four native
engines above. If a sandbox provider cannot host an engine's native runtime,
report that engine/provider pair as unsupported and stop. Do not silently
substitute ACP, another engine, or a reduced lifecycle.

Runtime generation is not workspace lifetime. Never delete or silently replace
a retained sandbox because a release, runtime label, or rollback is incompatible.
Preserve the workspace and upgrade safely or fail closed with a clear explanation.

## Provider-owned workspace invariant

Paths for execution, inputs, screenshots, artifact publishing, and delivery come
from the provider runtime layout of the sandbox already attached to the run.
Never treat `/root/work` as a universal workspace, select a new provider from
current settings to interpret retained files, or copy files into another home
directory to satisfy a publisher. Preserve canonical-path, symlink, and secret
protections. A deliverable is shared only after publication returns its durable
artifact reference; a path on sandbox disk alone is not delivery.
