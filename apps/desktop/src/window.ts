import { app, BrowserWindow, session, shell } from "electron";
import { join } from "node:path";
import { authScope } from "./auth-storage";
import { desktopContentPolicy, externalUrl, trustedIpcSender, trustedNavigation } from "./security";

/** The window owns browser policy; it never reads credentials or starts processes. */
export function createDesktopWindow(plane: URL): BrowserWindow {
  const browserSession = session.fromPartition(`persist:useagent-${authScope(plane.origin)}`);
  const localPermissions = new Set(["local-network", "local-network-access", "loopback-network"]);
  const allowPermission = (permission: string, origin: string) =>
    plane.protocol === "http:" && localPermissions.has(permission) && trustedIpcSender(origin, true, plane.origin);
  browserSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(allowPermission(permission, contents.getURL()));
  });
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    Boolean(contents && allowPermission(permission, requestingOrigin)));
  browserSession.webRequest.onHeadersReceived({ urls: [`${plane.origin}/*`] }, (details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    const name = Object.keys(responseHeaders).find(key => key.toLowerCase() === "content-security-policy") ?? "Content-Security-Policy";
    const contentPolicy = desktopContentPolicy(details.resourceType, details.statusCode, responseHeaders, app.isPackaged);
    if (contentPolicy.block) {
      callback({ cancel: true });
      return;
    }
    responseHeaders[name] = [...(responseHeaders[name] ?? []), contentPolicy.policy];
    callback({ responseHeaders });
  });
  const windowIcon = join(
    app.getAppPath(),
    process.platform === "win32" ? "resources/icon.ico" : "resources/icon.png",
  );
  const window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 640, show: false,
    icon: windowIcon,
    autoHideMenuBar: true,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 12 } } : {}),
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "preload.cjs"),
      additionalArguments: [`--useagent-version=${app.getVersion()}`],
      session: browserSession,
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      webviewTag: false, allowRunningInsecureContent: false, experimentalFeatures: false,
    },
  });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.on("will-navigate", (event, url) => {
    if (!trustedNavigation(url, plane.origin)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!trustedNavigation(url, plane.origin)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { void shell.openExternal(externalUrl(url)).catch(() => undefined); } catch { /* Denied below. */ }
    return { action: "deny" };
  });
  window.once("ready-to-show", () => window.show());
  return window;
}
