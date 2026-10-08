import { parseCookies } from "better-auth/cookies";
import type { BrowserWindow } from "electron";
import { oauthCallbackToken } from "./deep-link";

export type DesktopAuthClient = {
  requestAuth(): Promise<void>;
  authenticate(input: { token: string }): Promise<{ error: { message?: string } | null }>;
  getCookie(): string;
  getSession(): Promise<{ data: { session: { activeOrganizationId?: string | null } } | null; error: unknown }>;
  organization: {
    list(): Promise<{ data: Array<{ id: string; name: string }> | null; error: unknown }>;
    setActive(input: { organizationId: string }): Promise<{ error: unknown }>;
  };
};

export type DesktopOrganization = { id: string; name: string };
export const desktopOrganizationLabel = (organization: DesktopOrganization): string =>
  `${organization.name} (${organization.id})`;

const AUTH_COOKIE = /^(?:__Secure-|__Host-)?better-auth\.(?:session_token|session_data)$/;

function callbackToken(value: string): string {
  const token = oauthCallbackToken(value);
  if (!token) throw new Error("Invalid desktop sign-in callback.");
  return token;
}

/** Better Auth owns PKCE and the one-use exchange; only its session cookies enter the app partition. */
export function createDesktopSignIn(
  plane: URL,
  window: BrowserWindow,
  client: DesktopAuthClient,
  chooseOrganization: (organizations: readonly DesktopOrganization[]) => Promise<string | undefined>,
) {
  const ensureActiveOrganization = async (): Promise<boolean> => {
    const session = await client.getSession();
    if (session.error) {
      throw new Error("Desktop workspace could not be verified.");
    }
    if (!session.data) return false;
    const organizations = await client.organization.list();
    if (organizations.error || !Array.isArray(organizations.data)) throw new Error("Desktop workspace could not be verified.");
    const available = organizations.data.filter(organization =>
      typeof organization.id === "string" && organization.id.length > 0
      && typeof organization.name === "string" && organization.name.length > 0);
    const active = session.data.session.activeOrganizationId;
    // A stored workspace the user was removed from counts as unset, so a remaining membership can still open.
    if (active && available.some(organization => organization.id === active)) return true;
    const organizationId = available.length === 1 ? available[0]!.id
      : available.length > 1 ? await chooseOrganization(available) : undefined;
    if (!organizationId || !available.some(organization => organization.id === organizationId)) {
      throw new Error("Desktop workspace was not selected.");
    }
    if ((await client.organization.setActive({ organizationId })).error) {
      throw new Error("Desktop workspace could not be selected.");
    }
    return true;
  };
  /** Chromium keeps its own copy of the session cookie; a failed restore must not leave it signed in. */
  const clearAuthCookies = async (): Promise<void> => {
    const { cookies } = window.webContents.session;
    const stale = await cookies.get({ url: plane.href });
    await Promise.all(stale.filter(cookie => AUTH_COOKIE.test(cookie.name)).map(cookie => cookies.remove(plane.href, cookie.name)));
  };
  const restore = async (): Promise<boolean> => {
    const cookies = await ensureActiveOrganization()
      ? [...parseCookies(client.getCookie())].filter(([name]) => AUTH_COOKIE.test(name))
      : [];
    if (!cookies.some(([name]) => name.endsWith(".session_token"))) {
      await clearAuthCookies();
      return false;
    }
    await Promise.all(cookies.map(([name, cookie]) => window.webContents.session.cookies.set({
      url: plane.href, name, value: cookie, path: "/", httpOnly: true,
      secure: plane.protocol === "https:", sameSite: "lax",
    })));
    return true;
  };
  return {
    begin: () => client.requestAuth(),
    restore,
    async complete(value: string): Promise<void> {
      const result = await client.authenticate({ token: callbackToken(value) });
      if (result.error) throw new Error("Desktop sign-in could not be verified. Try again.");
      if (!await restore()) throw new Error("Invalid sign-in response.");
      await window.loadURL(plane.href);
      window.show();
      window.focus();
    },
  };
}
