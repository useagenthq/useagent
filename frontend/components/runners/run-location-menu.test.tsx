import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { UseAgentDesktopBridge } from "./desktop-bridge";
import {
  RunLocationMenu,
  RunLocationPanel,
  defaultRunLocation,
  isRunLocationShortcut,
  runLocationShortcutHint,
  runnerStatusSettled,
  submittedRunLocation,
  toggledRunLocation,
} from "./run-location-menu";
import { selectRunCreateAttempt } from "@/lib/create-run";

const bridge: UseAgentDesktopBridge = {
  version: "1.0.0",
  platform: "darwin",
  connectRunner: async () => {},
  runnerStatus: async () => ({ state: "online" }),
  openExternal: () => {},
};

describe("run location menu", () => {
  test("defaults to Local only while this machine's runner can take work", () => {
    expect(defaultRunLocation({ state: "online" })).toBe("local");
    for (const state of ["starting", "pulling", "offline", "error"] as const) {
      expect(defaultRunLocation({ state })).toBe("cloud");
    }
    expect(defaultRunLocation(null)).toBe("cloud");
    expect(toggledRunLocation("local")).toBe("cloud");
    expect(toggledRunLocation("cloud")).toBe("local");
    // The default is taken only once the runner is past starting up, so a
    // machine still coming up is not fixed on Cloud by its first report.
    expect(runnerStatusSettled(null)).toBe(false);
    expect(runnerStatusSettled({ state: "starting" })).toBe(false);
    expect(runnerStatusSettled({ state: "pulling", progress: 0.4 })).toBe(false);
    for (const state of ["online", "offline", "error"] as const) expect(runnerStatusSettled({ state })).toBe(true);
  });

  test("the new-task composer mounts the menu through the desktop bridge and sends the choice on the root run", () => {
    // The composer owns a router and a capability catalog, so its wiring is read, not rendered.
    const composer = readFileSync(
      new URL("../../app/(workspace)/agent/new/new-task-composer.tsx", import.meta.url),
      "utf8",
    );
    expect(composer).toContain("useEffect(() => setBridge(desktopBridge()), []);");
    expect(composer).toContain("const location = submittedRunLocation(runLocation, bridge !== null && localRunnerAvailable(bridge.platform));");
    expect(composer).toContain("if (location !== runLocation) setRunLocation(location);");
    expect(composer).toContain("...(location ? { run_location: location } : {}),");
    // Nothing changes the choice while a submission is in flight.
    expect(composer).toContain("<RunLocationMenu bridge={bridge} location={runLocation} onChange={setRunLocation} disabled={submitting} />");
    // Machine logins and the local caption count only for a thread placed on the machine.
    expect(composer).toContain("useEnabledEngineConfig({ machineLogins: onMachine })");
    expect(composer).toContain("const machineRunsWork = useMachineRunsWork() && onMachine;");
  });

  test("the shortcut is the command key with the apostrophe, named for the platform", () => {
    expect(isRunLocationShortcut({ key: "'", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isRunLocationShortcut({ key: "'", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isRunLocationShortcut({ key: "'", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isRunLocationShortcut({ key: "k", metaKey: true, ctrlKey: false })).toBe(false);
    expect(runLocationShortcutHint("darwin")).toBe("Use ⌘' to switch");
    expect(runLocationShortcutHint("win32")).toBe("Use Ctrl+' to switch");
  });

  test("a submission pins an unmade choice, so a retry of a lost response keeps its body and key", () => {
    // Desktop app, runner still starting: the menu shows Cloud and the first
    // submission carries it; the web app carries nothing.
    expect(submittedRunLocation(null, true)).toBe("cloud");
    expect(submittedRunLocation(null, false)).toBeNull();
    expect(submittedRunLocation("local", true)).toBe("local");
    // Once pinned, the default that settles later (the runner came online) no
    // longer applies, so the retried body is identical and the attempt is reused.
    const pinned = submittedRunLocation(null, true);
    const first = selectRunCreateAttempt({ prompt: "x", run_location: pinned }, null, () => "key-1");
    const retry = selectRunCreateAttempt({ prompt: "x", run_location: submittedRunLocation(pinned, true) }, first, () => "key-2");
    expect(retry).toBe(first);
    expect(retry.idempotencyKey).toBe("key-1");
  });

  test("renders only under the desktop bridge, naming the current location", () => {
    expect(renderToStaticMarkup(<RunLocationMenu bridge={null} location="local" onChange={() => {}} />)).toBe("");
    const linux = renderToStaticMarkup(
      <RunLocationMenu bridge={{ ...bridge, platform: "linux" }} location="local" onChange={() => {}} />,
    );
    const windows = renderToStaticMarkup(
      <RunLocationMenu bridge={{ ...bridge, platform: "win32" }} location="local" onChange={() => {}} />,
    );
    expect(linux).toBe("");
    expect(windows).toBe("");
    const local = renderToStaticMarkup(<RunLocationMenu bridge={bridge} location="local" onChange={() => {}} />);
    expect(local).toContain('aria-label="Run location: Local"');
    // Before the runner status is read, an unmade choice shows as Cloud.
    const unchosen = renderToStaticMarkup(<RunLocationMenu bridge={bridge} location={null} onChange={() => {}} />);
    expect(unchosen).toContain('aria-label="Run location: Cloud"');
    const held = renderToStaticMarkup(<RunLocationMenu bridge={bridge} location="cloud" onChange={() => {}} disabled />);
    expect(held).toContain('disabled=""');
  });

  test("the panel offers Local with the machine's name and Cloud, checks the active one and shows the hint", () => {
    const panel = renderToStaticMarkup(
      <RunLocationPanel location="local" onChange={() => {}} machineName="This Mac" machineOnline platform="darwin" />,
    );
    // Static markup escapes the apostrophe in the hint.
    for (const text of ["Local", "Cloud", "This Mac", "A hosted computer", "Use ⌘&#x27; to switch"]) {
      expect(panel).toContain(text);
    }
    expect(panel.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(panel.match(/data-testid="run-location-check"/g)).toHaveLength(1);
    // The checked row is the Local row: its label follows the attribute before the next row starts.
    const pressed = panel.slice(panel.indexOf('aria-pressed="true"'));
    expect(pressed.indexOf("Local")).toBeLessThan(pressed.indexOf('aria-pressed="false"'));
    expect(panel).not.toContain("not connected");

    const away = renderToStaticMarkup(
      <RunLocationPanel location="cloud" onChange={() => {}} machineName="This Mac" machineOnline={false} platform="linux" />,
    );
    expect(away).toContain("This Mac, not connected");
    expect(away).toContain("Use Ctrl+&#x27; to switch");
    const checked = away.slice(away.indexOf('aria-pressed="true"'));
    expect(checked.indexOf("Cloud")).toBeLessThan(checked.indexOf("Local") === -1 ? Infinity : checked.indexOf("Local"));
  });
});
