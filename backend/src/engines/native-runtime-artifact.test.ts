import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildNativeRuntimeArtifactProbe,
  buildNativeRuntimeInstallCommand,
  NATIVE_RUNTIME_ARTIFACT,
  nativeRuntimeExecutable,
} from "./native-runtime-artifact";

describe("native runtime provenance", () => {
  test("rejects a same-version public runtime without the pinned fork source", async () => {
    const home = await mkdtemp(join(tmpdir(), "useagent-runtime-provenance-"));
    const layout = { home, workdir: join(home, "work"), runsAsRoot: false };
    const executable = nativeRuntimeExecutable(layout);
    const root = dirname(dirname(executable));
    try {
      await mkdir(dirname(executable), { recursive: true });
      await mkdir(join(root, "node_modules/t3/dist"), { recursive: true });
      await symlink("node_modules/t3/dist", join(root, "dist"));
      await Bun.write(executable, `#!/bin/sh\nexec node '${root}/dist/bin.mjs' "$@"\n`);
      await chmod(executable, 0o700);
      await Bun.write(join(root, "dist/T3_SOURCE_COMMIT"), "public-package\n");
      expect(
        Bun.spawnSync(["sh", "-c", buildNativeRuntimeArtifactProbe(layout)]).exitCode,
      ).not.toBe(0);
      // Even a copied source marker cannot pass without the checksum manifest.
      await Bun.write(
        join(root, "dist/T3_SOURCE_COMMIT"),
        `${NATIVE_RUNTIME_ARTIFACT.sourceCommit}\n`,
      );
      expect(
        Bun.spawnSync(["sh", "-c", buildNativeRuntimeArtifactProbe(layout)]).exitCode,
      ).not.toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("rejects a corrupt upload before dependencies install or a launcher is published", async () => {
    const home = await mkdtemp(join(tmpdir(), "useagent-runtime-upload-"));
    const stage = join(home, "stage");
    const layout = {
      home,
      workdir: join(home, "work"),
      runsAsRoot: false,
      bunExecutable: join(home, "install-should-not-run"),
    };
    try {
      await mkdir(stage);
      await Bun.write(join(stage, "part-0"), "corrupt archive");
      await Bun.write(layout.bunExecutable, `#!/bin/sh\ntouch '${home}/unexpected-install'\n`);
      await chmod(layout.bunExecutable, 0o700);
      const command = buildNativeRuntimeInstallCommand(layout, stage, [join(stage, "part-0")]);
      expect(Bun.spawnSync(["sh", "-c", command]).exitCode).not.toBe(0);
      expect(await Bun.file(join(home, "unexpected-install")).exists()).toBe(false);
      expect(await Bun.file(nativeRuntimeExecutable(layout)).exists()).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("generates portable shell for root and non-root substrate layouts", () => {
    for (const home of ["/root", "/home/user"]) {
      const layout = {
        home,
        workdir: `${home}/work`,
        runsAsRoot: home === "/root",
      };
      for (const command of [
        buildNativeRuntimeArtifactProbe(layout),
        buildNativeRuntimeInstallCommand(layout, `${home}/stage`, [`${home}/stage/part-0`]),
      ]) {
        expect(Bun.spawnSync(["sh", "-n", "-c", command]).exitCode).toBe(0);
      }
    }
  });
});
