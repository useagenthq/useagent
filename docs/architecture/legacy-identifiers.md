# Legacy identifier allowlist

Customer-facing copy, outbound attribution, and new identifiers use `useAgent` / `useagent`.
The old `skynet` strings may remain only in the compatibility contracts below.
Removing one requires a coordinated migration, not a cosmetic rename.

| Remaining identifier | Why it remains | Retirement condition |
|---|---|---|
| `org-skynet-dev`, `skynet-dev`, and `user-skynet-dev` | Persisted local-development identity referenced by seeded rows and fixtures. | Migrate existing development rows and all fixtures atomically. |
| Provider lanes `skynet`, `skynet-knowledge`, `skynet-memory`, `skynet-gateway`, and `skynet-timing` | Durable canonical-event and MCP source partitions. Historical events and active sandboxes use these values. | Add dual-read aliases, migrate durable rows, then retire old producers. |
| Sandbox/runtime names such as `skynet-run`, `skynet-agent-v17`, `skynet-acp-v3`, `skynet-thread-*`, and `skynet://` references | Active snapshot, inventory-label, native-session, and event-reference contracts. | Roll out new producers and dual-read consumers before relabeling existing sandboxes. |
| `.skynet` sandbox directories and `/opt/skynet` or `/var/lib/skynet` host paths | Existing sandbox images and host migration source paths. | Rebuild images and complete the checked-in host migration before deleting tombstones. |
| Legacy service, role, and script names in `deploy/` and `infra/` | Required to discover, migrate, stop, or remove old production resources safely. | Remove only after the migration scripts prove no legacy resources remain. |
| `skynet.meow.gs` and its sandbox wildcard | Legacy DNS/origin accepted during the app-domain cutover. | Retire after traffic, certificates, callbacks, and sandbox previews no longer depend on it. |
| `x-skynet-*` headers and `skynet:*` browser-storage keys | Compatibility aliases for already-deployed clients. | Remove after the minimum supported client release only emits the useAgent names. |
| `dev-skynet-secret-change-me` | Historical development encryption fallback for durable org-secret rows. Changing it without a key migration makes existing ciphertext unreadable. | Rewrap every affected development row under an explicit `SECRETS_ENCRYPTION_KEY`, then retire the fallback. |

This allowlist is intentionally narrow. Old-brand text outside these contracts is release residue
and should fail the public-release grep/audit.
