import { describe, expect, test } from "bun:test";

describe("artifact workspace package boundary", () => {
  test("stays dependency-free and runtime-neutral", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
    const tsconfig = await Bun.file(new URL("../tsconfig.json", import.meta.url)).json();
    const files = await Promise.all([
      Bun.file(new URL("../src/contracts.ts", import.meta.url)).text(),
      Bun.file(new URL("../src/index.ts", import.meta.url)).text(),
    ]);
    const source = files.join("\n");

    expect(manifest.dependencies).toBeUndefined();
    expect(tsconfig.compilerOptions?.lib).toEqual(["ESNext"]);
    expect(source).not.toMatch(/from ["'](?:node:|react|next\/|@\/|\.\.\/\.\.\/backend)/);
  });
});
