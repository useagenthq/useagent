# prompt-overrides — English-output patch for memory-core

Why: the upstream TencentDB-Agent-Memory distillation prompts (L1 fact
extraction, L1 dedup/merge, L2 scene consolidation, L3 persona) are written
almost entirely in Chinese, with a single mid-prompt "match the user's
language" line. The extraction model (claude-haiku-4.5) follows the dominant
prompt language, so English conversations produced Chinese memories (user
report 2026-08-05). Upstream HEAD (checked 2026-08-06) has the same prompts as
the deployed image and exposes no output-language config; the only `language`
knob in `tdai-gateway.yaml` is `memory.bm25.language`, which controls the BM25
tokenizer, not the LLM.

What: byte-for-byte copies of the four prompt files from the deployed image
(`agentmemory/memory-core:latest`, created 2026-08-03, id f9b286246d0e), each
with one `[CRITICAL LANGUAGE RULE - HIGHEST PRIORITY]` paragraph injected at
the top of its system prompt(s). Nothing else is changed.

How: `memory/docker-compose.yml` mounts these files read-only over
`/app/src/core/prompts/*.ts`. The image runs Bun directly on TS source, so
the overlay is the code that executes.

Upgrading the image: re-copy the four files from the new container
(`docker cp skynet-memory-core:/app/src/core/prompts/<f>.ts .`) and re-inject
the rule paragraphs (grep for `CRITICAL LANGUAGE RULE` in this dir to see the
exact insertions). If a new image ships prompts that already force
conversation-language output, delete this overlay instead.
