# @useagent/sandbox-cube

Cube (E2B-compatible API) behind the `SandboxProvider` contract, as a provider
plugin: `cubePlugin` in `src/plugin.ts` is everything the control plane needs
(config from env, provider factory, preview auth headers, runtime home). Talks
Cube through the `e2b` SDK; the provider (`src/provider.ts`) reads its own
`CUBE_*` connection settings from the process environment.

The control plane hands the provider its identity preflight command
(`SandboxProviderPorts.identityPreflightCommand`); Cube runs it before it
returns a fresh or retained sandbox.

Exports: `cubePlugin`, `cubeSandboxProvider`, `CubeProviderOptions`,
`cubePreviewAuthHeaders`, `CUBE_SANDBOX_DOMAIN`.
