# Native runtime assets

The backend image carries one immutable native runtime archive for sandbox
providers that do not have the runtime preinstalled. The archive is distributed
as a private release asset, not committed to Git.

`backend/runtime-assets/manifest.json` pins the release filename, archive hash,
embedded checksum-manifest hash, source commit, dependency version, and frozen
Bun dependency-lock hash. This archive is built from reviewed fork commit
`90dc3ebbb74b0e85f41c4cb3105a9f8994ce0bfa`, based on upstream
`v0.0.39-nightly.20260906.1293`. The package build includes both the server and
its bundled client before the source marker and checksums are recorded.
Artifact identity is not live engine/provider certification.

Stage a known local archive:

```sh
bun run deploy/stage-native-runtime.ts /path/to/native-runtime-90dc3ebbb74b.tar.gz
```

Without an argument, the script downloads the exact filename from the private
`v0.0.4` release using the authenticated `gh` CLI. It verifies the outer archive
hash, embedded source marker, embedded `SHA256SUMS` hash, and tracked dependency
lock before atomically placing the ignored archive under `backend/runtime-assets/`.

The backend Docker build carries the staged archive under
`/app/backend/runtime-assets/`, exposes stable links from
`/opt/useagent/native-runtime/`, and repeats the verification. Missing or
changed bytes fail the image build. CI stages the same release asset before
every backend image build, so local and published images use identical runtime
bytes.

`backend/runtime-assets/dependencies/` contains only `package.json` and the
frozen `bun.lock`. Runtime preparation installs that exact closure with
`bun install --frozen-lockfile`, then overlays the verified distribution. The
dependency directory's `node_modules` remains ignored and is never packaged as
source.

Reuse probes detect damaged files, launchers, and dependency symlinks. They are
corruption/reproducibility checks, not remote attestation against tenant code
with full access to a sandbox's tools and process environment. Credential
isolation remains the separate responsibility of the trusted control plane.

To publish a replacement, create a new uniquely named archive and manifest.
Never overwrite a release asset or reuse an archive filename for different
bytes. A runtime distribution change does not change harness protocol selection:
Codex, Claude Code, OpenCode, and Pi remain on their native engine drivers.

The matching `t3code-fork-90dc3ebbb74b.bundle` and `.patch` preserve the custom
source; their hashes and upstream prerequisite commit are recorded in
`third_party/t3code-fork.lock`. Fetch the recorded upstream prerequisite before
using the Git bundle. The v8 wire/session compatibility label remains separate
from byte identity. The isolated SQLite 42 → 47 → old-runner check preserves
project/thread identities and workspace paths; intentional migration data
repairs are not reversed by an application rollback.
