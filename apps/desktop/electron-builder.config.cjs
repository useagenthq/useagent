const development = process.env.USEAGENT_DESKTOP_DEV_PACKAGE === "1";

// The local runner binary is packaged for macOS only. Windows and Linux builds
// are cloud clients and must not fail when that binary is absent.
const macRunner = development
  ? []
  : [
      {
        from: "resources/runner/useagent-runner-darwin-${arch}",
        to: "useagent-runner-darwin-${arch}",
      },
    ];

module.exports = {
  appId: "org.useagent.desktop",
  productName: "useAgent",
  asar: true,
  protocols: [{ name: "useAgent sign-in", schemes: ["useagent"] }],
  directories: {
    buildResources: "build",
    output: "dist/packages",
  },
  files: [
    "dist/*.cjs",
    "resources/trayTemplate.svg",
    "build/icon.ico",
    "build/icons/32x32.png",
    "package.json",
  ],
  forceCodeSigning: !development,
  mac: {
    ...(development ? { identity: "-" } : {}),
    icon: "build/icon.icns",
    target: ["dmg", "zip"],
    artifactName: "UseAgent-${version}-darwin-${arch}.${ext}",
    category: "public.app-category.developer-tools",
    extraResources: macRunner,
    extendInfo: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: {
          localhost: { NSExceptionAllowsInsecureHTTPLoads: true },
          "127.0.0.1": { NSExceptionAllowsInsecureHTTPLoads: true },
        },
      },
    },
    hardenedRuntime: !development,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    binaries: development ? [] : ["Contents/Resources/useagent-runner-darwin-${arch}"],
    notarize: !development,
  },
  // NSIS is the Windows installer electron-updater can replace in place.
  // Unsigned CI builds set forceCodeSigning false so a missing certificate
  // does not fail the job. A release can still sign when a certificate is present.
  win: {
    icon: "build/icon.ico",
    target: ["nsis"],
    artifactName: "UseAgent-${version}-win-${arch}.${ext}",
    forceCodeSigning: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    artifactName: "UseAgent-${version}-win-${arch}.${ext}",
    shortcutName: "useAgent",
  },
  // AppImage auto-updates. The .deb does not: install a newer package instead.
  // deb.mimeTypes repeats the useagent scheme so the Debian desktop entry
  // advertises x-scheme-handler/useagent next to the shared protocols list.
  linux: {
    icon: "build/icons",
    target: ["AppImage", "deb"],
    category: "Development",
    executableName: "useagent",
    synopsis: "Desktop shell for a hosted UseAgent control plane",
    maintainer: "UseAgent <licensing@useagent.org>",
    artifactName: "UseAgent-${version}-linux-${arch}.${ext}",
    syncDesktopName: true,
  },
  deb: {
    // protocols also append this scheme, so the desktop MimeType line lists it twice.
    mimeTypes: ["x-scheme-handler/useagent"],
    // Ubuntu 24.04 renamed the t64 transition packages. An alternative keeps
    // the installer usable on Ubuntu 22.04 and 24.04.
    depends: [
      "libgtk-3-0 | libgtk-3-0t64",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libxtst6",
      "xdg-utils",
      "libatspi2.0-0 | libatspi2.0-0t64",
      "libuuid1",
      "libsecret-1-0",
    ],
  },
  publish: {
    provider: "github",
    owner: "useagenthq",
    repo: "useagent-pro",
  },
};
