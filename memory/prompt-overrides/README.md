# prompt-overrides — source-language prompts for memory-core

## Why this overlay exists

The upstream TencentDB-Agent-Memory L1 extraction, L1 deduplication, L2 scene
consolidation, and L3 persona prompts were predominantly written in Chinese.
With English conversations, the model could follow the instruction language
instead of the source language and generate Chinese memories, headings, and
default labels.

The `language` setting in `tdai-gateway.yaml` configures the BM25 tokenizer;
it does not control LLM output language.

## Permanent fix

These four overrides use English instruction scaffolds, labels, templates, and
examples. Each prompt also makes the output contract explicit:

- Natural-language output follows the dominant language of its source
  messages or memories.
- English source content stays English.
- Legitimate Chinese source content may produce Chinese output.
- Structural identifiers remain stable: JSON keys and enums, META keys,
  Markdown/control markers, tool names, IDs, and ISO timestamps are unchanged.

The rewrite removes prompt-language bias without forcing every user into
English and without changing exported TypeScript interfaces or JSON contracts.

## Runtime wiring

`memory/docker-compose.yml` mounts the files read-only over
`/app/src/core/prompts/*.ts`. The image runs Bun directly on TypeScript source,
so the mounted overrides are the executed prompts.

## Upgrading memory-core

When upgrading the image, compare the upstream prompt exports, parameter
shapes, JSON schemas, tool names, and deletion markers with these overrides.
Port any upstream contract changes while retaining the source-language rule
and English-first scaffolding. If upstream ships an equivalent fix, remove the
overlay after verifying English and Chinese source-language behavior end to
end.
