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

## Readiness and the private data plane

A fresh sandbox is accepted only after one probe passes every stage in order:
runtime identity, workspace, DNS of the preview host, DNS of a public host. The
failure names the stage that stopped it and the underlying text (for example
`failed readiness after 20 attempts at the command transport (envd over the data
plane): unable to get local issuer certificate`), in the run error and in the
backend log.

The data plane (`*.<CUBE_SANDBOX_DOMAIN>`, the envd RPC and every preview URL)
is served behind Caddy with a private CA. Production reaches it from the Cube
host, which trusts that CA. A backend or gateway that runs anywhere else must
trust the root itself: put the Caddy root certificate in a file and start the
process with `NODE_EXTRA_CA_CERTS=/path/to/caddy-root.crt`, otherwise every
command fails at the transport stage before the identity check can run.
