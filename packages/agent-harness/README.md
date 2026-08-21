# @skynet/agent-harness

Server-side agent-harness contracts. Translates native harnesses (OpenCode, Claude ACP,
Codex ACP, future) into ONE provider-neutral canonical event vocabulary and exposes a
typed control seam. Knows provider protocols; knows nothing about the useAgent backend,
database, Daytona, or the React UI.

`private: true`. No build step - raw TypeScript consumed via `file:` links.

## Exports

| Subpath | Contents |
|---|---|
| `@skynet/agent-harness/canonical` | The pure `CanonicalAgentEvent` vocabulary (`CanonicalEventBase` + `CanonicalEventBody`), `NegotiatedCapabilities`, `HarnessSession`, `assertNeverEvent`. **Zero dependencies** - the ONLY subpath the browser-facing `@skynet/agent-client` may import. |
| `@skynet/agent-harness/control` | The pure control contracts: legacy `HarnessAdapter` types plus the fuller `ProviderDriver` lifecycle descriptor (`start`/`resume`/`steer`/`cancel`, model capability, tool gateway, unsupported-capability result, and conformance helper). |
| `@skynet/agent-harness/opencode` | The OpenCode -> canonical translator + its `OpenCodeFrame`/`OpenCodeStep` shapes. |
| `.` (barrel) | All of the above. |

## Where it fits

```
OpenCode native ─┐
Claude ACP ───────┼─> @skynet/agent-harness -> CanonicalAgentEvent -> useAgent backend
Codex ACP ────────┘        (translate + control)   (persist -> thread SSE)
```

useAgent keeps the trusted control plane (execution, Daytona, auth/policy, DB/outbox, memory
/KB, the thread stream). This package is only the translation + control CONTRACT.

## Provider driver contract

`ProviderDriver` is the provider-owned lifecycle seam. It is intentionally typed in
terms of existing package vocabulary:

- `start` creates a provider-native session inside an already provisioned runtime;
  `resume` reattaches to that same canonical `HarnessSession`.
- `steer` accepts typed prompt, slash-command, approval, or question input.
- `cancel` accepts the same `HarnessSession`, so managed runtimes never need a fake
  `sandboxId`.
- `descriptor.capabilities` reuses `NegotiatedCapabilities`; there is no second product
  capability map.
- `descriptor.model` describes fixed versus per-turn model selection.
- `descriptor.tools` describes whether tools are absent, provider-native, or
  useAgent-brokered.

The driver does not allocate canonical event ids or durable sequence numbers. Native
event translation is a separate package concern; the trusted control plane enriches,
persists, and publishes translated event bodies. Keeping lifecycle control separate from
event accounting prevents a provider plugin from inventing useAgent ordering metadata.

Unsupported behavior must return `providerDriverUnsupported(...)` with status
`"unsupported_capability"` rather than throwing or pretending success. Use
`validateProviderDriver(...)` in provider conformance tests to catch descriptor and method
shape regressions early.

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
useAgent backend responsibilities, not this library's. No schema or runtime for this exists
yet; do not present it as implemented.
