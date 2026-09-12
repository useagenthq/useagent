# @useagent/sandbox-box

Box (box.ascii.dev) behind the `SandboxProvider` contract, as a provider
plugin: `boxPlugin` in `src/plugin.ts` is everything the control plane needs
(config from env, provider factory, credential validation, preview auth,
runtime home). Talks Box's public REST API directly; no SDK.

Verified live: create, commands, files, detached long commands, session kill,
hosted-port auth (`_token` -> `_port_auth` cookie), list with labels,
archive/resume, delete. See `src/provider.ts` for the Box facts that shaped it.

## Base image and terminals

Box's base image ships `/usr/local/bin/opencode` as a launcher shim whose
fallback points back at itself, so `opencode --version` never returns. The
OpenCode engine probes the binary before its first boot in a sandbox and, when
it does not answer within a few seconds, boots through `npx opencode-ai@<pinned>`
with a visible timeline step. Nothing in this repository builds that image; a
`BOX_SNAPSHOT` with a real runtime skips the bootstrap.

Interactive terminals ride the Box CLI (`box login`, `box ssh`), because Box has
no PTY API. `boxCliProblem()` (also `boxPlugin.interactiveTerminalProblem()`)
says whether the `box` binary is on this server's PATH; `createPty` throws the
contract's `SandboxTerminalUnavailableError` with that reason so the product
shows one calm line instead of a reconnect loop.
