import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/mac-demo-harness.sh", import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv = {}): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bash", script, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe("mac demo harness", () => {
  test("bash syntax stays valid", () => {
    const proc = Bun.spawnSync(["bash", "-n", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(script, "utf8")).toContain('stopped_at="$(now_utc)"');
  });

  test("start dry-run emits deterministic session and ffmpeg planning", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "skynet-demo-harness-"));
    try {
      const result = run(
        [
          "--dry-run",
          "--base-dir",
          baseDir,
          "--screen-device",
          "Capture screen 0",
          "start",
          "--scenario",
          "Login Journey",
          "--engine",
          "Codex",
          "--label",
          "PR Demo",
        ],
        {
          SKYNET_DEMO_SESSION_ID: "fixed-session",
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("session_id=fixed-session--login-journey--codex--pr-demo");
      expect(result.stdout).toContain(join(baseDir, "fixed-session--login-journey--codex--pr-demo"));
      expect(result.stdout).toContain("ffmpeg:");
      expect(result.stdout).toContain("-f avfoundation");
      expect(result.stdout).toContain("-capture_cursor 1");
      expect(result.stdout).toContain("-capture_mouse_clicks 1");
      expect(result.stdout).toContain("-pixel_format bgr0");
      expect(result.stdout).toContain('Capture screen 0:none');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("control commands emit the native OS tools, not browser automation", async () => {
    const result = run(["--dry-run", "click", "100", "200"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cliclick:");
    expect(result.stdout).toContain("c:100,200");

    const drag = run(["--dry-run", "drag", "10", "20", "30", "40"]);
    expect(drag.exitCode).toBe(0);
    expect(drag.stdout).toContain("dd:10,20");
    expect(drag.stdout).toContain("dm:30,40");
    expect(drag.stdout).toContain("du:30,40");

    const hotkey = run(["--dry-run", "hotkey", "cmd", "shift", "f"]);
    expect(hotkey.exitCode).toBe(0);
    expect(hotkey.stdout).toContain("osascript:");
    expect(hotkey.stdout).toContain(String.raw`keystroke\ \"f\"`);
    expect(hotkey.stdout).toContain(String.raw`command\ down\,shift\ down`);

    const specialHotkey = run(["--dry-run", "hotkey", "cmd", "arrow-left"]);
    expect(specialHotkey.exitCode).toBe(0);
    expect(specialHotkey.stdout).toContain("kp:arrow-left");

    const shotDir = await mkdtemp(join(tmpdir(), "skynet-demo-harness-shot-"));
    try {
      const screenshot = run(["--dry-run", "shot", "--session-dir", shotDir, "login"]);
      expect(screenshot.exitCode).toBe(0);
      expect(screenshot.stdout).toContain("screencapture:");
    } finally {
      rmSync(shotDir, { recursive: true, force: true });
    }

    const focus = run(["--dry-run", "focus", "Google Chrome"]);
    expect(focus.exitCode).toBe(0);
    expect(focus.stdout).toContain("osascript:");
    expect(focus.stdout).toContain("Google\\ Chrome");
    expect(focus.stdout).toContain("activate");
  });

  test("pause/stop dry-run keeps the redaction boundary explicit", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "skynet-demo-harness-stop-"));
    try {
      const sessionDir = join(baseDir, "fixed-session--login--codex--demo");
      mkdirSync(sessionDir, { recursive: true });

      const result = run(
        ["--dry-run", "pause", "--session-dir", sessionDir],
        {
          SKYNET_DEMO_SESSION_ID: "fixed-session",
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`session_dir=${sessionDir}`);
      expect(result.stdout).toContain("redaction_boundary=true");
      expect(result.stdout).toContain("ffprobe -hide_banner");
      expect(result.stdout).toContain("kill -INT");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("stop sends SIGINT so the recorder can finalize before probing", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "skynet-demo-harness-sigint-"));
    const fakeRecorder = join(baseDir, "fake-ffmpeg.sh");
    const fakeProbe = join(baseDir, "fake-ffprobe.sh");
    const signalFile = join(baseDir, "signal.txt");
    const readyFile = join(baseDir, "ready.txt");
    const sessionId = "sigint-session--finalize--codex--demo";
    const sessionDir = join(baseDir, sessionId);

    try {
      writeFileSync(
        fakeRecorder,
        `#!/usr/bin/env python3
import os
import signal
import sys
import time

video_path = sys.argv[-1]

def finalize(_signum, _frame):
    with open(os.environ["SKYNET_TEST_SIGNAL_FILE"], "w", encoding="utf-8") as marker:
        marker.write("INT")
    open(video_path, "a", encoding="utf-8").close()
    raise SystemExit(0)

signal.signal(signal.SIGINT, finalize)
with open(os.environ["SKYNET_TEST_READY_FILE"], "w", encoding="utf-8") as marker:
    marker.write("ready")
while True:
    time.sleep(0.05)
`,
      );
      writeFileSync(
        fakeProbe,
        `#!/usr/bin/env bash
printf 'codec_name=h264\\nwidth=1280\\nheight=720\\nduration=1.25\\nsize=42\\n'
`,
      );
      chmodSync(fakeRecorder, 0o755);
      chmodSync(fakeProbe, 0o755);

      const env = {
        SKYNET_DEMO_SESSION_ID: "sigint-session",
        SKYNET_DEMO_CREATED_AT: "2026-08-22T00:00:00Z",
        SKYNET_FFMPEG_BIN: fakeRecorder,
        SKYNET_FFPROBE_BIN: fakeProbe,
        SKYNET_TEST_SIGNAL_FILE: signalFile,
        SKYNET_TEST_READY_FILE: readyFile,
      };
      const started = run(
        ["--base-dir", baseDir, "start", "--scenario", "Finalize", "--engine", "Codex", "--label", "Demo"],
        env,
      );
      expect(started.exitCode).toBe(0);

      for (let attempt = 0; attempt < 100 && !existsSync(readyFile); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(readyFile)).toBe(true);

      const stopped = run(["--base-dir", baseDir, "stop", "--session-dir", sessionDir], env);
      expect(stopped.exitCode).toBe(0);
      expect(readFileSync(signalFile, "utf8")).toBe("INT");
      expect(stopped.stdout).toContain("codec=h264 width=1280 height=720 duration=1.25 size=42");
      expect(existsSync(join(sessionDir, `${sessionId}.pid`))).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
