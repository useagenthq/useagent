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
snapshot pins live: `DAYTONA_SNAPSHOT` (OpenCode, Pi, the CLI lane; a root
image) and `DAYTONA_ACP_SNAPSHOT` (Claude and Codex over ACP; a non-root image).
Set either variable in the deployment env to move off the pin; `template(env,
templateEnv)` resolves the variable first and the pin second. `skynet-agent-v23`
exists in the product org too but lacks the desktop binaries the Browser surface
needs.

Daytona parks a snapshot nobody used for about two weeks as `inactive`, and a
create from it fails. `DaytonaProvider.ensureTemplate(name)` looks the snapshot
up before a create: absent snapshots are reported as such (the run fails by
name), inactive ones are activated and polled for up to six minutes while the
caller shows a step, and any other state carries Daytona's error reason. The
1 vCPU default image is declared as `baseImageResources` so the control plane
never silently lands on it unless the operator lowered the resource target.
