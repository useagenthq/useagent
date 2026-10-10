import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import { _electron, type ElectronApplication } from "playwright-core";
import { deepLinkToken, startMockPlane } from "./mock-plane";

/**
 * End-to-end smoke test for the packaged desktop app. It launches the real
 * built app, waits for the window, checks the sign-in screen renders, and
 * checks a useagent:// link is handled by completing a full sign-in: the
 * preload bridge starts the browser sign-in, the system browser request is
 * captured by the mock control plane, and the deep link exchanges the PKCE
 * code for a session that opens the workspace.
 *
 * The app ships a macOS runner only, so the test runs on macOS against the
 * app produced by `bun run package:dev` (the unsigned directory target).
 * Linux joins under xvfb once Linux builds exist.
 *
 * This is a Node script rather than a bun test because Playwright's Electron
 * transport needs Node's WebSocket stack: under bun, `_electron.launch` and
 * `connectOverCDP` both stall on the socket handshake. bun builds it
 * (`build:smoke`) exactly like it builds the app itself, and the mock plane's
 * contract is covered by the bun unit tests.
 */

const WINDOW_TIMEOUT = 30_000;
const BROWSER_HANDOFF_TIMEOUT = 45_000;
const DEEP_LINK_TIMEOUT = 30_000;

function packagedAppExecutable(): string {
  const override = process.env.USEAGENT_SMOKE_APP;
  if (override) return override;
  const packages = join(import.meta.dirname, "..", "..", "dist", "packages");
  if (existsSync(packages)) {
    const entries = readdirSync(packages, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const entry of entries) {
      const candidates = readdirSync(join(packages, entry.name), { withFileTypes: true })
        .filter((candidate) => candidate.isDirectory() && candidate.name.endsWith(".app"));
      for (const candidate of candidates) {
        const binaries = readdirSync(join(packages, entry.name, candidate.name, "Contents", "MacOS"));
        const binary = binaries.find((name) => name === candidate.name.replace(/\.app$/, ""));
        if (binary) return join(packages, entry.name, candidate.name, "Contents", "MacOS", binary);
      }
    }
  }
  throw new Error(`No packaged app found under ${packages}. Run bun run package:dev first.`);
}

async function waitFor(description: string, probe: () => Promise<string | null>, timeout: number): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await probe();
    if (current !== null) return current;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description} after ${timeout}ms.`);
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" && !process.env.USEAGENT_SMOKE_APP) {
    throw new Error("The desktop app ships a macOS runner only; run the smoke test on macOS.");
  }
  const executable = packagedAppExecutable();
  const plane = await startMockPlane();
  const artifacts = join(import.meta.dirname, "..", "..", "dist", "smoke-artifacts");
  mkdirSync(artifacts, { recursive: true });
  let app: ElectronApplication | undefined;
  const logs: string[] = [];
  try {
    console.log(`Launching ${executable}`);
    app = await _electron.launch({
      executablePath: executable,
      args: [],
      env: { ...process.env, USEAGENT_PLANE_URL: plane.origin },
    });
    app.process().stderr?.on("data", (chunk) => logs.push(String(chunk)));
    const page = await app.firstWindow();

    // The window opens on the sign-in screen and the preload bridge answers IPC.
    await waitFor(
      "the sign-in screen",
      async () => {
        const current = await page.title();
        return current === "Sign in - UseAgent" ? current : null;
      },
      WINDOW_TIMEOUT,
    );
    const heading = await waitFor(
      "the sign-in heading",
      async () => (await page.textContent("h1")) === "Sign in to UseAgent" ? "Sign in to UseAgent" : null,
      WINDOW_TIMEOUT,
    );
    const runner = await waitFor(
      "the runner status from the preload bridge",
      async () => {
        const status = await page.textContent("#runner-status");
        return /^Runner is /.test(status ?? "") ? status : null;
      },
      WINDOW_TIMEOUT,
    );
    assert.equal(heading, "Sign in to UseAgent");
    assert.equal(runner, "Runner is offline");
    await page.screenshot({ path: join(artifacts, "sign-in.png") });
    console.log("The sign-in screen rendered and the preload bridge answered.");

    // The sign-in button hands off to the system browser, which brings the
    // PKCE request to the mock plane.
    await page.click("#continue-in-browser");
    await waitFor(
      "the browser sign-in request",
      async () => (plane.authorizations.length > 0 ? "captured" : null),
      BROWSER_HANDOFF_TIMEOUT,
    );
    const authorization = plane.authorizations[0]!;
    console.log(`The system browser brought the PKCE request (state ${authorization.state}).`);

    // A useagent:// link with the plane token completes the sign-in. The second
    // instance carries the link to the running app, which exchanges the code
    // and opens the workspace. It exits on its own once the single-instance
    // lock relays the link.
    const link = `useagent://auth/callback#token=${deepLinkToken(authorization)}`;
    const secondInstance = spawn(executable, [link], { stdio: "ignore" });
    secondInstance.unref();
    await waitFor(
      "the desktop token exchange",
      async () => (plane.exchanged ? "exchanged" : null),
      DEEP_LINK_TIMEOUT,
    );
    console.log("The useagent:// link completed the PKCE exchange.");
    await waitFor(
      "the workspace after the deep link",
      async () => {
        const current = new URL(page.url());
        return current.pathname === "/" && current.search === "" ? "/" : null;
      },
      DEEP_LINK_TIMEOUT,
    );
    assert.equal(await page.textContent("#workspace-name"), "Smoke Workspace");
    assert.ok((await page.title()).startsWith("UseAgent"));
    await page.screenshot({ path: join(artifacts, "workspace.png") });
    console.log("The workspace opened. Smoke test passed.");
  } catch (error) {
    if (logs.length > 0) console.error(`app stderr:\n${logs.join("")}`);
    throw error;
  } finally {
    if (app) {
      await Promise.race([
        app.close(),
        sleep(10_000).then(() => app?.process().kill("SIGKILL")),
      ]);
    }
    await plane.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
