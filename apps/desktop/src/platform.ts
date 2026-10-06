/** The bundled local runner ships on macOS only. Windows and Linux are cloud clients. */
export function localRunnerAvailable(platform: string): boolean {
  return platform === "darwin";
}

export type TrayIcon = {
  /** Path relative to the packaged app directory (`app.getAppPath()`). */
  readonly relativePath: string;
  /** macOS template images follow the menu bar. Linux and Windows use a color icon. */
  readonly template: boolean;
};

export function trayIcon(platform: string): TrayIcon {
  if (platform === "linux") return { relativePath: "build/icons/32x32.png", template: false };
  if (platform === "win32") return { relativePath: "build/icon.ico", template: false };
  return { relativePath: "resources/trayTemplate.svg", template: true };
}

/**
 * electron-updater can install a newer macOS zip, Windows NSIS installer, or
 * Linux AppImage. The AppImage runtime sets `APPIMAGE`; a .deb package does
 * not, and it has no auto-update. Install a newer .deb with the system
 * package manager.
 */
export function autoUpdateSupported(platform: string, env: NodeJS.ProcessEnv): boolean {
  if (platform === "darwin" || platform === "win32") return true;
  if (platform === "linux") return typeof env.APPIMAGE === "string" && env.APPIMAGE.length > 0;
  return false;
}

export type TrayEntry =
  | { readonly kind: "status"; readonly label: string }
  | { readonly kind: "separator" }
  | { readonly kind: "toggle-window"; readonly label: string }
  | { readonly kind: "quit"; readonly label: string };

/** Tray rows. Local runner status is omitted where the runner does not ship. */
export function trayMenuEntries(input: {
  readonly localRunner: boolean;
  readonly runnerState: string;
  readonly image: string;
  readonly windowVisible: boolean;
}): readonly TrayEntry[] {
  const windowLabel = input.windowVisible ? "Hide UseAgent" : "Open UseAgent";
  const tail: readonly TrayEntry[] = [
    { kind: "separator" },
    { kind: "toggle-window", label: windowLabel },
    { kind: "quit", label: "Quit" },
  ];
  if (!input.localRunner) return [{ kind: "status", label: "Cloud client" }, ...tail];
  return [
    { kind: "status", label: `Runner: ${input.runnerState}` },
    { kind: "status", label: "Sandboxes: Unknown" },
    { kind: "status", label: `Image: ${input.image}` },
    ...tail,
  ];
}
