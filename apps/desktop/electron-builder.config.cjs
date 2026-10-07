const development = process.env.USEAGENT_DESKTOP_DEV_PACKAGE === "1";

module.exports = {
  appId: "org.useagent.desktop",
  productName: "useAgent",
  asar: true,
  protocols: [{ name: "useAgent sign-in", schemes: ["useagent"] }],
  directories: {
    buildResources: "build",
    output: "dist/packages",
  },
  files: ["dist/*.cjs", "resources/**", "package.json"],
  extraResources:
    development || process.platform !== "darwin"
      ? []
      : [
          {
            from: "resources/runner/useagent-runner-darwin-${arch}",
            to: "useagent-runner-darwin-${arch}",
          },
        ],
  mac: {
    forceCodeSigning: !development,
    ...(development ? { identity: "-" } : {}),
    icon: "build/icon.icns",
    target: ["dmg", "zip"],
    artifactName: "UseAgent-${version}-darwin-${arch}.${ext}",
    category: "public.app-category.developer-tools",
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
  win: {
    icon: "build/icon.ico",
    target: [
      {
        target: "nsis",
        arch: ["x64"],
      },
      {
        target: "zip",
        arch: ["x64"],
      },
    ],
    artifactName: "UseAgent-${version}-win-${arch}.${ext}",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: "UseAgent",
  },
  linux: {
    icon: "build/icons",
    target: [
      {
        target: "AppImage",
        arch: ["x64"],
      },
      {
        target: "deb",
        arch: ["x64"],
      },
    ],
    artifactName: "UseAgent-${version}-linux-${arch}.${ext}",
    category: "Development",
  },
  publish: {
    provider: "github",
    owner: "useagenthq",
    repo: "useagent-pro",
  },
};
