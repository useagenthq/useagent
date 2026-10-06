import { describe, expect, test } from "bun:test";
import { autoUpdateSupported, localRunnerAvailable, trayIcon, trayMenuEntries } from "./platform";

describe("local runner platform gate", () => {
  test("ships on macOS and stays hidden on Windows and Linux", () => {
    expect(localRunnerAvailable("darwin")).toBe(true);
    expect(localRunnerAvailable("win32")).toBe(false);
    expect(localRunnerAvailable("linux")).toBe(false);
    expect(localRunnerAvailable("freebsd")).toBe(false);
  });

  test("tray menu keeps runner rows on macOS and shows a cloud client elsewhere", () => {
    const mac = trayMenuEntries({
      localRunner: localRunnerAvailable("darwin"),
      runnerState: "online",
      image: "runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      windowVisible: true,
    });
    expect(mac.map((entry) => entry.kind === "separator" ? "separator" : entry.label)).toEqual([
      "Runner: online",
      "Sandboxes: Unknown",
      "Image: runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "separator",
      "Hide UseAgent",
      "Quit",
    ]);

    for (const platform of ["win32", "linux"] as const) {
      const menu = trayMenuEntries({
        localRunner: localRunnerAvailable(platform),
        runnerState: "online",
        image: "hidden",
        windowVisible: false,
      });
      const labels = menu.map((entry) => entry.kind === "separator" ? "separator" : entry.label);
      expect(labels).toEqual(["Cloud client", "separator", "Open UseAgent", "Quit"]);
      expect(labels.join(" ")).not.toContain("Runner");
      expect(labels.join(" ")).not.toContain("Sandboxes");
      expect(labels.join(" ")).not.toContain("hidden");
    }
  });
});

describe("tray icon and auto-update", () => {
  test("uses a template glyph on macOS, a PNG on Linux, and an ICO on Windows", () => {
    expect(trayIcon("darwin")).toEqual({ relativePath: "resources/trayTemplate.svg", template: true });
    expect(trayIcon("linux")).toEqual({ relativePath: "build/icons/32x32.png", template: false });
    expect(trayIcon("win32")).toEqual({ relativePath: "build/icon.ico", template: false });
  });

  test("auto-update covers NSIS and AppImage, not a Debian package", () => {
    expect(autoUpdateSupported("darwin", {})).toBe(true);
    expect(autoUpdateSupported("win32", {})).toBe(true);
    expect(autoUpdateSupported("linux", { APPIMAGE: "/home/ava/Applications/UseAgent.AppImage" })).toBe(true);
    expect(autoUpdateSupported("linux", {})).toBe(false);
    expect(autoUpdateSupported("linux", { APPIMAGE: "" })).toBe(false);
  });
});
