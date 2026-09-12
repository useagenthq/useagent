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
