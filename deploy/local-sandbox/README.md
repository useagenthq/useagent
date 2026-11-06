# Local sandbox image

The image a developer's machine boots for local sandboxes (the `local`
provider, `packages/sandbox-local`, served by `packages/runner`).

Two layers, both built by `.github/workflows/local-sandbox-image.yml` for
amd64 and arm64:

1. `Dockerfile.base`: what the cloud sandbox base provides, on public Debian,
   plus the desktop the native recipe installs on the cloud bases: a real Xorg
   on the dummy driver at 1920x1080, Budgie (daemon, panel, window manager),
   gnome-terminal, pcmanfm for the desktop icons and wallpaper, the dark
   Adwaita defaults in dconf, x11vnc and noVNC for the stream, Chromium. Then
   Node with the engine command lines at the pinned versions, Bun at the
   sandbox version, `socat` for port dials, and the non-root `user` (uid 1000,
   home `/home/user`, passwordless sudo for the recipe's apt steps).
   `rootfs/` holds the files the recipe's desktop step would write (the Xorg
   display and wrapper configuration, the dconf profile and defaults, the
   pcmanfm desktop items and the launchers in `/home/user/Desktop`): on this
   base that step's probe finds the stack complete and exits before writing
   anything, so the base carries the files itself.
   `backend/src/sandboxes/local-sandbox-base.test.ts` holds the package list
   and those files equal to the recipe.
2. The native recipe from `backend/src/sandboxes/native-image.ts`, rendered
   for the non-root layout by
   `backend/scripts/render-native-image.ts --layout local`: the native runtime,
   the engine bootstraps, Pi, the document toolchain, the desktop launcher and
   its probe (a no-op on this base).

The workflow publishes `ghcr.io/useagenthq/sandbox:<native image name>` and
records its digest in the `local-sandbox-image.json` artifact. A deployment
sets those two values as `SANDBOX_IMAGE_REF` and `SANDBOX_IMAGE_DIGEST`; the
control plane names them to every runner in `welcome`, and the runner pulls
the reference and refuses to create a sandbox until the digest matches.

What is pinned: the Debian base by its index digest, Node and Bun by version
and checksum, the engine tools by version. Debian packages come from the
distribution's mirror at build time, so two publishes can differ in package
versions; each publish records what it installed in
`/usr/share/useagent/base-packages.txt` inside the image, and the digest a
deployment pins is what its runners boot. Move to a new publish deliberately.

The cloud lanes (Cube, Box, Daytona) keep their own bakes from the cloud base
(`deploy/hetzner/bake-native-images.sh`); the recipe, the runtime archive and
the engine versions are the same, the base is not, so the digests differ.

## Building on a Mac for certification

```
docker build -f deploy/local-sandbox/Dockerfile.base -t sandbox-base:dev deploy/local-sandbox
# render inside a Linux Bun (the renderer needs the sandbox Bun on Linux and the staged runtime):
docker run --rm -v "$PWD":/repo -w /repo/backend oven/bun:1.3.14 bun run scripts/render-native-image.ts --out ../render --layout local
docker build --build-arg USEAGENT_NATIVE_BASE_IMAGE=sandbox-base:dev -t localhost:5000/sandbox:dev render
docker push localhost:5000/sandbox:dev   # a local registry gives the image a digest the runner can verify
```

To prove the desktop on the base alone, start it the way the runner does
(`docker run -d --init sandbox-base:dev sleep infinity`), place the launcher
and relay the recipe ships (`buildDesktopLaunchScript()` in
`backend/src/engines/desktop-workstation.ts` at
`/home/user/.local/bin/useagent-desktop-launch`, `desktopCdpRelaySource()` in
`desktop-cdp-relay.ts` with a token beside it in the state directory the
recipe names in `backend/src/sandboxes/sandbox-names.ts`), run
the launcher detached as `user`, and wait for `buildDesktopReadinessCommand()`
to pass: Xorg on `:1`, the Budgie session, the relay, x11vnc answering `RFB`
on 5900 and noVNC on 6080.
