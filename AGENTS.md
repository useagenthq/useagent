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
