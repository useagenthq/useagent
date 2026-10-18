# Legacy identifier allowlist

Code, copy, docs and new identifiers use `useAgent` / `useagent`. The product's
first name, `skynet`, stays only where a value is already persisted or deployed
under it: renaming one of those would strand data, a live sandbox or a running
deployment. Code names each by what it does and keeps the value in one place.

`backend/test/ratchet.test.ts` enforces this: the name may appear only in the
files it lists, at most as often as recorded, and a count may only shrink.

| Kept value | Where it is defined | Why it stays | Retire when |
|---|---|---|---|
| Sandbox state directory `.skynet`, and the `skynet-` prefix of process sessions, runtime ids, the repo ownership marker, the secrets dotenv, the Claude config dir, the Codex provider id and exec environment, the CDP relay header and the image's recording commands | `backend/src/sandboxes/sandbox-names.ts` | Retained sandboxes, baked images and the in-sandbox runtime's state hold these names; a new name would start a second resident process or lose a live thread. | A sandbox generation that every retained sandbox has been migrated to. |
| Event lanes `skynet`, `skynet-memory`, `skynet-gateway`, `skynet-timing`, `skynet-knowledge`; tool server ids `skynet-knowledge`, `skynet-browser` | `packages/agent-harness/src/canonical.ts` | Stored in the `provider` column of every provider event and in recorded tool calls; readers match exact values. | A data migration that rewrites stored rows, with readers accepting both until it lands. |
| Key-derivation labels and the development secret fallback | `backend/src/knowledge/gateway/token.ts`, `backend/src/provider-gateway/token.ts`, `backend/src/knowledge/gateway/approval-capability.ts`, `backend/src/secrets/crypto.ts`, `backend/src/security/runtime-secrets.ts` | Issued tokens and capabilities verify under them, and stored org secrets are sealed under them. | A key rotation that reissues tokens and rewraps every stored secret. |
| Dev org id `org-skynet-dev` | `backend/src/dev-org.ts` | Existing development databases key their rows to it. | A migration of development rows. |
| Database role `skynet_gateway`; sandbox labels `skynet-run`, `skynet-provider-generation`, `skynet-warm-pool-template` | `backend/src/db/gateway-grants.ts`, `backend/src/sandboxes/label-compat.ts`, `backend/src/sandboxes/cube-warm-pool-reconcile.ts` | Databases and sandboxes created before the rename carry them; both names are accepted. | No database or sandbox carries the old name. |
| Artifact source-path roots `/.skynet/artifact-workspace` and `/.skynet/provider-output` | `backend/src/artifacts/authoring.ts`, `backend/src/artifacts/publish.ts` | Stored artifact rows hold these paths; reads map them to the current root. | A migration of stored source paths. |
| Explicit-memory tag and session `skynet-explicit-memory` | `backend/src/memory/explicit-memory.ts`, `backend/src/memory/team-memory.ts` | Memories already stored in the memory service carry them. | A memory-service migration. |
| Former host paths: Codex login root `.skynet/codex-app-server`, scratch prefixes `skynet-wiki-` and `skynet-read-` | `backend/src/provider-connections/codex-app-server-pool.ts`, `backend/src/wiki-gen/clone.ts` | Existing logins are still found there, and old scratch directories are still cleaned. | Hosts have moved off the old paths. |
| Cube session directory and the earlier `SKYNET_*` process env names | `packages/sandbox-cube/src/provider.ts` | Live Cube processes were started under them. | Every resident and warm-pool Cube sandbox has cycled. |
| Daytona snapshot `skynet-agent-v17` | `packages/sandbox-daytona/src/plugin.ts` | The published snapshot carries this name. | A snapshot published under the new name. |
| Knowledge folder key `skynet-app` | `frontend/app/(library)/knowledge/knowledge-data.ts` | Stored knowledge items keep the key; the UI shows it as UseAgent. | A migration of stored folder keys. |
| Memory gateway `instanceId` and the `skynet-memory-core-data` volume | `memory/tdai-gateway.yaml`, `memory/docker-compose.yml` | Running memory deployments were set up with them and hold their data there. | A memory migration. |
| The desktop launcher path in the local sandbox image | `deploy/local-sandbox/rootfs/home/user/Desktop/browser.desktop` | It points into the sandbox state directory above. | With the state directory. |

`backend/test/persisted-names.test.ts` pins each value literally (the knowledge
folder key is pinned in `knowledge-brand.test.tsx`), so a change fails there first. Recorded test fixtures that captured these values
(`backend/test/fixtures/runtime-v2/codex-turn-provider-failure.json`,
`packages/agent-harness/test/fixtures/opencode-heavy.json`) and the test of the
Cube env fallback keep them too.
