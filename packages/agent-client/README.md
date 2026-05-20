# @skynet/agent-client

The browser/runtime-neutral Skynet thread client. Understands ONLY the Skynet product API
plus canonical/thread events. Knows nothing about OpenCode, ACP, Claude, Codex, Daytona,
secrets, or databases, and imports no React, Next, backend, or provider module. Its only
bare imports are the zero-dependency canonical protocol and artifact-workspace contracts.

A UI supplies fetch, EventSource, timers, base URL, and auth headers; the library owns the
typed API, the reconnect/replay connection, the canonical reducer, and selectors.

`private: true`. No build step - raw TypeScript consumed via `file:` links.

## Exports

| Subpath | Contents |
|---|---|
| `@skynet/agent-client/api` | `createAgentClient` (typed API over injected fetch: createRun / reply / cancel / getThread / connectThread), `AgentClientError` (classified http/network/decode). |
| `@skynet/agent-client/artifacts` | Durable `ArtifactDescriptor` validation and artifact response decoders. |
| `@skynet/agent-client/connection` | `createThreadConnection` - the pure SSE reconnect / health / fallback-poll state machine. |
| `@skynet/agent-client/events` | The thread SSE frame vocabulary + `CanonicalThreadEvent` wire type + the pure `decodeFrame`. |
| `@skynet/agent-client/store` | `createCanonicalThreadStore` - the pure canonical reducer (dedupe by eventId/latest-revision, order by deliverySeq, batch, stable snapshots). |
| `@skynet/agent-client/selectors` | `selectAssistantText` / `selectToolCalls` / `selectLatestUsage` / `selectContextMarkers` / `selectRunIds`. |
| `.` (barrel) | All of the above. |

## Contract rules

- inject `fetch`, EventSource factory, timers, base URL, and auth headers; never read
  global state;
- reconcile from the server snapshot/replay after reconnect;
- duplicate + revised canonical events are idempotent;
- transport, wire decoding, canonical reduction, and any UI live in separate modules;
- expose capabilities + typed operations, never provider-name branches;
- classified failures, no raw secrets or unbounded provider payloads.

## Consuming from a Turbopack/Next app

bun's `file:` install symlinks each package file into `node_modules`, and Turbopack's
inferred project root is the app dir, so it rejects the out-of-root symlinked `package.json`
("Invalid symlink"). The Skynet frontend fixes this in `frontend/next.config.ts` with
`turbopack.root` = the repository root + a `turbopack.resolveAlias` mapping the bare
specifiers to the package sources + `transpilePackages`. A non-Turbopack consumer (bun,
Node, Vite) needs none of this - see `packages/conformance` for a framework-free example.

## Durable artifacts + future renderer registry

The implemented file-transfer architecture and remaining renderer/storage work
are documented in [`ARTIFACTS.md`](./ARTIFACTS.md). The client owns strict
artifact wire decoding and typed list/get operations. A future
`ArtifactRendererRegistry` remains product-owned and stays out of this package.
