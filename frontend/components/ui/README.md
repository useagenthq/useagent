# components/ui - legacy AlignUI primitives (dialog layer only)

This is the legacy AlignUI primitive library, kept ONLY as the sanctioned
dialog/overlay layer: Modal, Drawer, CommandMenu and their internal deps
(popover, dropdown, tooltip, button, kbd, ...). BoardUI ships no dialog
primitives, so overlays stay on this layer while every product surface is
BoardUI-tokened (styles/theme.css + styles/typography.css).

Rules:

- Do not add NEW usages outside dialogs/overlays.
- New UI builds on components/base (BoardUI).
- These files keep their legacy AlignUI utilities (bg-bg-white-0,
  text-label-sm, ...) and resolve through the compat bridge in
  app/globals.css; do not purge them and do not extend the bridge.
