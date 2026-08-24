# @useagent/sandbox-contract

The provider-neutral sandbox contract for useAgent.

A sandbox is a remote workstation the platform provisions per run. This package
declares WHAT that workstation can do, never WHO provides it: the provider
surface (`create` / `get` / `list`) and the `SandboxHandle` surfaces for
process execution and interactive sessions, filesystem transfer, PTYs, port
preview links, screen recording, and optional native computer-use.

It is a pure leaf: types only, zero imports, zero runtime. Any runtime can
depend on the contract without pulling in server code.

## What lives where

- **Here:** the interfaces (`SandboxProvider`, `SandboxHandle`, `SandboxProcess`,
  `SandboxFileSystem`, `SandboxPtyHandle`, `SandboxComputerUse`,
  `SandboxRecording`, `SandboxPreviewLink`, `SandboxCreateOptions`,
  `SandboxExecuteResult`, `SandboxSession`) and the `SandboxProviderKind`
  discriminant.
- **In the backend:** the concrete adapters (Daytona, Cube), the warm pools, and
  the env-coupled selectors (`sandboxProvider()`, `sandboxProviderKind()`,
  `sandboxPreviewHeaders`, provider-specific config). The conformance harness
  runs there against live providers.

`backend/src/sandboxes/provider.ts` re-exports every symbol from this package, so
backend call sites keep their existing import paths.

## Verification

Run from this package:

```sh
bun test
bunx tsc --noEmit
```
