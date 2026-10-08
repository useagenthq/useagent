import {
  app,
  type BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MessageBoxOptions,
  nativeImage,
  safeStorage,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { autoUpdater } from "electron-updater";
import { join } from "node:path";
import { desktopChannels } from "./desktop-api";
import { deepLinkFromArgv, isOAuthCallbackUrl } from "./deep-link";
import { autoUpdateSupported, localRunnerAvailable, trayIcon, trayMenuEntries } from "./platform";
import { createRunnerController, stopRunnerBeforeQuit, type RunnerStatus } from "./runner";
import { desktopLoadErrorMessage, externalUrl, planeManifest, planeUrl, runnerToken, trustedIpcSender } from "./security";
import { createTokenStore } from "./token-store";
import { createDesktopWindow } from "./window";
import { createDesktopSignIn, desktopOrganizationLabel, type DesktopOrganization } from "./sign-in";
import { createDesktopAuthClient } from "./auth-client";

const keepRunningInBackground = process.env.USEAGENT_KEEP_RUNNING_IN_BACKGROUND === "1";
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let quitAfterRunnerStops = false;
let signIn: ReturnType<typeof createDesktopSignIn> | undefined;
let pendingDeepLink: string | undefined;

function completeSignIn(url: string): void {
  if (!signIn) {
    pendingDeepLink = url;
    return;
  }
  void signIn.complete(url).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("desktop sign-in failed:", reason);
    dialog.showErrorBox("Sign-in did not complete", `${reason}\n\nReturn to UseAgent and try signing in again.`);
  });
}

/** One path for macOS open-url and for Windows/Linux argv. Only the OAuth callback signs in. */
function deliverDeepLink(url: string | null | undefined): void {
  if (!url || !isOAuthCallbackUrl(url)) return;
  completeSignIn(url);
}

function takePendingDeepLink(): string | undefined {
  const url = pendingDeepLink;
  pendingDeepLink = undefined;
  return url;
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});

function runnerBinary(): string {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("This desktop build does not include a runner for this platform.");
  }
  return join(process.resourcesPath, `useagent-runner-darwin-${process.arch}`);
}

function trusted(event: IpcMainInvokeEvent | IpcMainEvent, origin: string): void {
  if (!trustedIpcSender(event.senderFrame?.url ?? "", event.senderFrame === mainWindow?.webContents.mainFrame, origin)) {
    throw new Error("Unauthorized desktop request.");
  }
}

async function loadManifest(origin: string): Promise<{ image: string }> {
  try {
    const response = await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error();
    return planeManifest(await response.json());
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("This desktop requires")) throw error;
    throw new Error(`Could not verify desktop compatibility with ${origin}.`);
  }
}

function configureUpdater(): void {
  if (!app.isPackaged) return;
  // Packaged macOS, NSIS, AppImage, and DEB targets are supported by electron-updater.
  if (!autoUpdateSupported(process.platform, process.env)) return;
  const reportFailure = (): void => console.error("[desktop:update] UPDATE_FAILED");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on("error", reportFailure);
  const check = () => void autoUpdater.checkForUpdatesAndNotify().catch(reportFailure);
  check();
  setInterval(check, 4 * 60 * 60_000).unref();
}

async function startDesktop(): Promise<void> {
  if (process.platform === "win32") app.setAppUserModelId("org.useagent.desktop");
  if (app.isPackaged) app.setAsDefaultProtocolClient("useagent");
  const plane = planeUrl(process.env.USEAGENT_PLANE_URL);
  const manifest = await loadManifest(plane.origin);
  const localRunner = localRunnerAvailable(process.platform);
  let shellStatus: RunnerStatus | undefined;
  let runner: ReturnType<typeof createRunnerController> | undefined;
  let runnerStore: ReturnType<typeof createTokenStore> | undefined;
  if (localRunner) {
    runnerStore = createTokenStore(join(app.getPath("userData"), "runner-token"), plane.origin, safeStorage);
    const store = runnerStore;
    runner = createRunnerController({
      binary: runnerBinary(),
      plane: plane.origin,
      shareLogins: [],
      onTokenRejected: () => void store.remove(),
    });
    try {
      const token = await runnerStore.read();
      if (token) await runner.start(token);
    } catch {
      shellStatus = { state: "error", detail: "Secure runner token storage could not be read.", progress: 0 };
    }
  }
  const activeRunner = runner;
  app.on("before-quit", (event) => {
    quitting = true;
    if (!activeRunner) return;
    if (quitAfterRunnerStops) return;
    event.preventDefault();
    void stopRunnerBeforeQuit(
      () => activeRunner.stop(),
      () => {
        quitAfterRunnerStops = true;
        app.quit();
      },
    ).catch(() => { quitting = false; });
  });

  ipcMain.handle(desktopChannels.connectRunner, async (event, token: unknown) => {
    trusted(event, plane.origin);
    if (!activeRunner || !runnerStore) throw new Error("Local runs are available on macOS only.");
    const validToken = runnerToken(token);
    await runnerStore.write(validToken);
    shellStatus = undefined;
    await activeRunner.restart(validToken);
  });
  ipcMain.handle(desktopChannels.runnerStatus, async (event) => {
    trusted(event, plane.origin);
    if (!activeRunner) return { state: "offline", detail: "Local runs are available on macOS only.", progress: 0 };
    return shellStatus ?? activeRunner.getStatus();
  });
  ipcMain.on(desktopChannels.openExternal, (event, url: unknown) => {
    try {
      trusted(event, plane.origin);
      if (typeof url === "string" && url === new URL("/desktop-auth", plane).href) {
        void signIn?.begin().catch(() => dialog.showErrorBox("Browser unavailable", "Could not open the sign-in browser."));
        return;
      }
      void shell.openExternal(externalUrl(url)).catch(() => undefined);
    } catch {
      // Ignore requests outside the trusted top frame.
    }
  });

  const window = createDesktopWindow(plane);
  mainWindow = window;
  signIn = createDesktopSignIn(
    plane,
    window,
    createDesktopAuthClient(plane, app.getPath("userData")),
    async (organizations: readonly DesktopOrganization[]) => {
      const options: MessageBoxOptions = {
        type: "question",
        title: "Choose workspace",
        message: "Choose the workspace to open in UseAgent.",
        buttons: [...organizations.map(desktopOrganizationLabel), "Cancel"],
        defaultId: 0,
        cancelId: organizations.length,
        noLink: true,
      };
      const result = window.isVisible()
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      return organizations[result.response]?.id;
    },
  );
  // A failed restore has already cleared Chromium's auth cookies; only a verified session opens the product.
  const restored = await signIn.restore();
  mainWindow.on("close", (event) => {
    if (keepRunningInBackground && !quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  const icon = trayIcon(process.platform);
  const trayImage = nativeImage.createFromPath(join(app.getAppPath(), icon.relativePath));
  if (icon.template) trayImage.setTemplateImage(true);
  if (trayImage.isEmpty()) console.error("[desktop] tray icon is missing");
  tray = new Tray(trayImage);
  tray.setToolTip("UseAgent");
  const refreshTray = (): void => {
    const status = activeRunner ? (shellStatus ?? activeRunner.getStatus()) : undefined;
    const entries = trayMenuEntries({
      localRunner,
      runnerState: status?.state ?? "offline",
      image: manifest.image,
      windowVisible: mainWindow?.isVisible() ?? false,
    });
    tray?.setContextMenu(
      Menu.buildFromTemplate(entries.map((entry) => {
        if (entry.kind === "separator") return { type: "separator" as const };
        if (entry.kind === "toggle-window") {
          return {
            label: entry.label,
            click: () => (mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show()),
          };
        }
        if (entry.kind === "quit") return { label: entry.label, click: () => app.quit() };
        return { label: entry.label, enabled: false };
      })),
    );
  };
  refreshTray();
  setInterval(refreshTray, 1_000).unref();
  configureUpdater();
  const callback = takePendingDeepLink();
  if (callback) {
    try {
      await signIn.complete(callback);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error("desktop sign-in failed:", reason);
      dialog.showErrorBox("Sign-in did not complete", `${reason}\n\nReturn to UseAgent and try signing in again.`);
      await mainWindow.loadURL(new URL("/login", plane).href);
    }
  } else {
    await mainWindow.loadURL(restored ? plane.href : new URL("/login", plane).href);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows and Linux pass useagent:// on argv. macOS uses open-url, registered above.
  if (process.platform === "win32" || process.platform === "linux") {
    deliverDeepLink(deepLinkFromArgv(process.argv));
  }
  app.on("second-instance", (_event, argv) => {
    if (process.platform === "win32" || process.platform === "linux") deliverDeepLink(deepLinkFromArgv(argv));
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.whenReady().then(startDesktop).catch((error: unknown) => {
    dialog.showErrorBox("UseAgent could not start", desktopLoadErrorMessage(error));
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (!keepRunningInBackground) app.quit();
});
