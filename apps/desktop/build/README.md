# Desktop app icons

Application icon set for the useAgent desktop app. The source is `icon.svg`: the
brand orbit-knot mark (same path and blue gradient as
`frontend/components/foundations/brand/orbit-knot-mark.tsx`) on a dark rounded
square laid out on the macOS 1024 px icon grid (824 px shape, 100 px margin).
Everything else in this directory is generated from it.

| File | Use |
| --- | --- |
| `icon.svg` | Source of truth. Edit this, then regenerate. |
| `icon.png` | 1024 x 1024 render. |
| `icon.icns` | macOS icon (16 to 512 px plus @2x variants), built by `iconutil`. |
| `icon.ico` | Windows icon: 16, 32, 48, 64, 128 and 256 px, PNG encoded. |
| `icons/<size>x<size>.png` | 16, 32, 48, 64, 128, 256, 512 and 1024 px for Linux and Windows. |

## Regenerate

```sh
bun apps/desktop/build/make-icons.ts
```

Needs `rsvg-convert` (`brew install librsvg`, `apt install librsvg2-bin`) or
`magick` on PATH. `icon.icns` is produced only on macOS (`iconutil`); on other
platforms the script skips it and leaves the committed file in place. Output is
byte-identical across runs, so a regenerate with no `icon.svg` change produces
no diff. Sizes at 32 px and below are rendered with a heavier stroke so the
mark still reads in the Dock and taskbar.

## electron-builder

```json
{
  "directories": { "buildResources": "build" },
  "mac": { "icon": "build/icon.icns" },
  "win": { "icon": "build/icon.ico" },
  "linux": { "icon": "build/icons" }
}
```

`buildResources` is the default, so with the keys above unset electron-builder
also picks up `build/icon.icns`, `build/icon.ico` and `build/icons/` on its own.
The tray loads `icon.ico` on Windows and `icons/32x32.png` on Linux, so those
two files are also copied into the app. macOS keeps using `resources/trayTemplate.svg`.

A Debian package does not auto-update. The NSIS installer and the AppImage do.
