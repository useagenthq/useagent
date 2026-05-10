# @skynet/agent-harness

Server-side agent-harness contracts. Translates native harnesses (OpenCode, Claude ACP,
Codex ACP, future) into ONE provider-neutral canonical event vocabulary and exposes a
typed control seam. Knows provider protocols; knows nothing about the Skynet backend,
database, Daytona, or the React UI.

`private: true`. No build step - raw TypeScript consumed via `file:` links.

## Exports

| Subpath | Contents |
|---|---|
| `@skynet/agent-harness/canonical` | The pure `CanonicalAgentEvent` vocabulary (`CanonicalEventBase` + `CanonicalEventBody`), `NegotiatedCapabilities`, `HarnessSession`, `assertNeverEvent`. **Zero dependencies** - the ONLY subpath the browser-facing `@skynet/agent-client` may import. |
| `@skynet/agent-harness/control` | The pure `HarnessAdapter` control types (`HarnessCapabilities`, `HarnessSessionHandle`, `HarnessOperationResult`, `HarnessReconciliation`). |
| `@skynet/agent-harness/opencode` | The OpenCode -> canonical translator + its `OpenCodeFrame`/`OpenCodeStep` shapes. |
| `.` (barrel) | All of the above. |

## Where it fits

```
OpenCode native ─┐
Claude ACP ───────┼─> @skynet/agent-harness -> CanonicalAgentEvent -> Skynet backend
Codex ACP ────────┘        (translate + control)   (persist -> thread SSE)
```

Skynet keeps the trusted control plane (execution, Daytona, auth/policy, DB/outbox, memory
/KB, the thread stream). This package is only the translation + control CONTRACT.

## Testing

`bun test` runs the canonical-vocabulary lock, the OpenCode translator golden-fixture
accounting, and an import-boundary test (every `src/**` import must be relative `./`, so
no product/runtime code can leak in). `bunx tsc --noEmit` typechecks it standalone.

## Future: durable artifacts (documented contract only - NOT built)

Provider tool/file results will one day become durable, first-class artifacts. The seam is
recorded in [`../agent-client/ARTIFACTS.md`](../agent-client/ARTIFACTS.md). The harness's
responsibility in that flow is narrow: a translator emits a small canonical **artifact
lifecycle reference** (`created`/`updated`/`completed`/`failed` + a stable id/version), and
NEVER the bytes. Ingestion, the `ArtifactDescriptor`, ACL, and out-of-band storage are
Skynet backend responsibilities, not this library's. No schema or runtime for this exists
yet; do not present it as implemented.
