# @useagent/sandbox-daytona

Daytona behind the `SandboxProvider` contract, as a provider plugin:
`daytonaPlugin` in `src/plugin.ts` is everything the control plane needs
(config from env, provider factory, snapshot credential validation, preview
auth header, runtime home). Wraps the official `@daytona/sdk` client; the
provider (`src/provider.ts`) takes a `DaytonaClientPort` so tests run without
the SDK.

Exports: `daytonaPlugin`, `daytonaApiConfig`, `DaytonaApiConfig`,
`DaytonaProvider`, `daytonaSandboxProvider`, `daytonaPreviewAuthHeaders`,
`validateDaytonaConnection`, plus the `DaytonaClientPort` /
`DaytonaSandboxPort` seams.

## Snapshots

`DAYTONA_SNAPSHOT_DEFAULTS` in `src/plugin.ts` is the one place the product
snapshot pins live: `DAYTONA_SNAPSHOT` (the native Codex, Claude, OpenCode, Pi,
and CLI lanes; a root image) and `DAYTONA_ACP_SNAPSHOT` (the explicitly
registered ACP compatibility lane). A native Codex, Claude, OpenCode, or Pi
engine never selects ACP because of its sandbox provider. Set either variable
in the deployment env to move off the pin; `template(env, templateEnv)` resolves
the variable first and the pin second.
`skynet-agent-v23` exists in the product org too but lacks the desktop binaries
the Browser surface needs.

The operator owns the snapshot named by `DAYTONA_SNAPSHOT`. In addition to the
root runtime layout, it must provide an account named `user` at uid 1000 with
primary gid 1000 and an owned, writable, non-symlink home at `/home/user`, plus
`setfacl` and `setpriv`. The Claude wrapper uses that identity when it drops
privileges. `deploy/hetzner/Dockerfile.claude-nonroot-layer` is the portable
prerequisite layer: it creates the account and group only when their names and
numeric ids are unused, and otherwise fails rather than renaming or replacing
an existing identity. Building the layer does not select or mutate a Daytona
snapshot; snapshot creation and the deployment pin remain explicit operator
actions.

Daytona parks a snapshot nobody used for about two weeks as `inactive`, and a
create from it fails. `DaytonaProvider.ensureTemplate(name)` looks the snapshot
up before a create: absent snapshots are reported as such (the run fails by
name), inactive ones are activated and polled for up to six minutes while the
caller shows a step, and any other state carries Daytona's error reason. The
1 vCPU default image is declared as `baseImageResources` so the control plane
never silently lands on it unless the operator lowered the resource target.
