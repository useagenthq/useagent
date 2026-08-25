# memory-core runtime overrides

`l1-extractor.ts` was copied from the live `skynet-memory-core` container on
2026-08-26. The container and repository default use the same pinned image:

`agentmemory/memory-core@sha256:f9b286246d0e5020a7f0cb011b7074703d10b76b424a834a117482392f7bd424`

The unmodified live file SHA-256 was
`d95ddbe2a2cc9f328bd3dd432abc8dab0c45b867fba6be6985efc325a3861a72`.
The vendored file differs only in the L1 output-language policy integration.
Re-copy and rebase this narrow patch whenever the pinned image changes.
