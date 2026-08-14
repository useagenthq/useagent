# Beautiful UI source snapshot

This directory contains the 19 React/TypeScript component sources published at
<https://www.beautifului.dev/> and the complete MIT license published at
<https://www.beautifului.dev/license>.

The component text is preserved exactly as decoded from the upstream Next.js
React Server Component payload. Source files use the `.tsx.txt` suffix so this
unwired snapshot remains outside the skynet-a TypeScript compilation boundary.
`manifest.json` records each intended `.tsx` filename, source hash, byte count,
RSC record id, imports, upstream deployment id, Next build id, static chunk
names, page ETags, and fetch timestamp.

Nothing in this directory is imported by production code. Before adopting a
component, port it deliberately into the existing design system and resolve its
recorded upstream imports. No dependency was added as part of this snapshot.

Validate the snapshot with:

```sh
bun test vendor/beautiful-ui/manifest.test.ts
```
