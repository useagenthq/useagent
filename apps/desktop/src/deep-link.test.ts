import { describe, expect, test } from "bun:test";
import { deepLinkFromArgv, isOAuthCallbackUrl, oauthCallbackFromArgv, oauthCallbackToken } from "./deep-link";

const callback = "useagent://auth/callback#token=official_token";

describe("deep link argv", () => {
  test("reads a Windows cold start and a second instance", () => {
    const cold = [
      "C:\\Users\\Ava\\AppData\\Local\\Programs\\useAgent\\useAgent.exe",
      callback,
    ];
    const second = [
      "C:\\Users\\Ava\\AppData\\Local\\Programs\\useAgent\\useAgent.exe",
      "--allow-file-access-from-files",
      `"${callback}"`,
    ];
    expect(deepLinkFromArgv(cold)).toBe(callback);
    expect(oauthCallbackFromArgv(cold)).toBe(callback);
    expect(oauthCallbackFromArgv(second)).toBe(callback);
  });

  test("reads a Linux cold start, including an AppImage launch", () => {
    const deb = ["/opt/UseAgent/useagent", callback];
    const appImage = [
      "/tmp/.mount_useagent/useagent",
      "--no-sandbox",
      callback,
    ];
    expect(deepLinkFromArgv(deb)).toBe(callback);
    expect(oauthCallbackFromArgv(appImage)).toBe(callback);
    expect(oauthCallbackFromArgv(["/usr/bin/useagent", "--no-sandbox"])).toBeNull();
  });

  test("leaves a normal macOS launch to open-url and still accepts an explicit argv URL", () => {
    const launched = ["/Applications/useAgent.app/Contents/MacOS/useAgent", "-psn_0_12345"];
    expect(deepLinkFromArgv(launched)).toBeNull();
    expect(oauthCallbackFromArgv(launched)).toBeNull();
    const explicit = ["/Applications/useAgent.app/Contents/MacOS/useAgent", callback];
    expect(oauthCallbackFromArgv(explicit)).toBe(callback);
  });

  test("keeps the OAuth callback and ignores other links", () => {
    expect(oauthCallbackToken(callback)).toBe("official_token");
    expect(oauthCallbackToken("useagent://auth/callback#token=official_token=")).toBe("official_token=");
    expect(isOAuthCallbackUrl(callback)).toBe(true);
    expect(isOAuthCallbackUrl("useagent://thread/42")).toBe(false);
    expect(oauthCallbackFromArgv(["useagent", "useagent://thread/42"])).toBeNull();
    expect(deepLinkFromArgv(["useagent", "useagent://thread/42"])).toBe("useagent://thread/42");
    expect(deepLinkFromArgv(["useagent", "https://app.useagent.org"])).toBeNull();
    expect(oauthCallbackFromArgv(["useagent", "useagent://auth/callback#token=nope&extra=1"])).toBeNull();
    expect(oauthCallbackFromArgv(["useagent", "not a url"])).toBeNull();
  });
});
