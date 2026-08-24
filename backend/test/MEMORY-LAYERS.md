# Memory layers verification matrix

useAgent integrates Tencent MemoryCore as four provider layers, numbered `L0`
through `L3`. The product's learned procedure and skill-promotion workflow is a
separate governed lane. It is not a Tencent `L4`.

## Provider layers

| Layer | Provider source | Write path | Read path | Regression evidence |
| --- | --- | --- | --- | --- |
| L0 raw turns | conversation messages | completed salient runs are committed to `memory_outbox`, then delivered through `POST /v3/conversation/add`; explicit remembers use the same provider layer synchronously | `POST /v3/conversation/search` | `finalize.test.ts`, `capture-outbox.test.ts`, `team-memory.test.ts`, `memory-tools.test.ts`, `memory-two-sandbox.live.test.ts` |
| L1 atomic facts | MemoryCore distillation | derived asynchronously by MemoryCore from L0 | `POST /v3/atomic/search` | `team-memory.test.ts`, `memory-tools.test.ts` |
| L2 scenes | MemoryCore scenario summaries | derived asynchronously by MemoryCore from L0 | `POST /v3/scenario/ls`, then `POST /v3/scenario/read` for a selected scene | `team-memory.test.ts`, `memory-tools.test.ts` |
| L3 persona | MemoryCore bounded core profile | derived asynchronously by MemoryCore from L0 | `POST /v3/core/read` | `team-memory.test.ts`, `memory-tools.test.ts` |

The runtime resolves every provider request from the persisted run identity.
Organization memory uses `(team_id=orgId, user_id=org:orgId)`. Personal memory
reads the authenticated user's private pool first and the organization pool
second, while writing only to the private pool. A personal run without an
authenticated user fails closed.

## Product learning and promotion lane

The procedure lane starts from completed run evidence but does not write a live
skill automatically:

1. `finalizeRun` atomically commits the completed run and a `learning_outbox`
   intent.
2. The worker builds a reviewable knowledge draft only for eligible, verified
   outcomes.
3. An organization administrator may accept the draft into organization
   knowledge. An unaccepted or dismissed draft changes no live knowledge.
4. Repeated similar accepted learnings may raise an inert skill-revision
   proposal.
5. A second explicit organization-admin acceptance creates or versions a real
   playbook through the normal skills repository.

This lane is covered by `learning-outbox.test.ts`, `knowledge-drafts.test.ts`,
and `skill-proposals.test.ts`. Keeping it separate prevents MemoryCore's
asynchronous semantic distillation from silently changing executable agent
behavior.

## Reproduce

Prepare the isolated test database once, then run the bounded matrix:

```bash
cd backend
bun run test/prepare-db.ts
bun run test:memory-matrix
```

`memory-two-sandbox.live.test.ts` is an additional opt-in provider proof. It is
skipped unless `MEMORY_LIVE_TEST=1` and a reachable `MEMORY_API_URL` are set,
because it writes a canary to the configured MemoryCore pool.

## Honest limits

- The deterministic suite verifies our endpoint contract, ordering, citations,
  isolation, outbox behavior, and degraded-versus-empty semantics with a
  stateful provider double.
- It does not assert a fixed L0-to-L1/L2/L3 distillation delay. MemoryCore owns
  that asynchronous process, so a fixed sleep would create a flaky and false
  product guarantee.
- The live two-sandbox proof verifies immediate L0 continuity. L1-L3 provider
  derivation needs a separately provisioned disposable tenant before it can be
  tested without polluting a real organization's memory.
