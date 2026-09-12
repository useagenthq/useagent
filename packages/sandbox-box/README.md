# @useagent/sandbox-box

Box (box.ascii.dev) behind the `SandboxProvider` contract, as a provider
plugin: `boxPlugin` in `src/plugin.ts` is everything the control plane needs
(config from env, provider factory, credential validation, preview auth,
runtime home). Talks Box's public REST API directly; no SDK.

Verified live: create, commands, files, detached long commands, session kill,
hosted-port auth (`_token` -> `_port_auth` cookie), list with labels,
archive/resume, delete. See `src/provider.ts` for the Box facts that shaped it.
