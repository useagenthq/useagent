// Render the native image recipe as a Dockerfile plus build context, for
// providers whose templates come from images (Cube). Runs where the runtime
// assets ship (the backend container) and writes into a directory the host can
// build from:
//
//   bun run scripts/render-native-image.ts --out /var/lib/useagent/scratch/native-image
//
// Then on the host:
//   DOCKERFILE=<out>/Dockerfile BUILD_CONTEXT=<out> BASE_IMAGE_ARG=USEAGENT_NATIVE_BASE_IMAGE \
//     deploy/hetzner/bake-sandbox-template.sh <tag> <base-image-ref>
//
// `--check` prints the image name and exits.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeProviderGatewayEnvironment } from "../src/provider-gateway/sandbox-config";
import { loadNativeImageInputs, nativeImageName, renderNativeImageDockerfile } from "../src/sandboxes/native-image";
import { sandboxRuntimeLayout } from "../src/sandboxes/provider";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const claudeEnvironment = claudeProviderGatewayEnvironment();
if (process.argv.includes("--check")) {
  console.log(nativeImageName({ claudeEnvironment }));
  process.exit(0);
}
const out = argument("out");
if (!out) throw new Error("--out DIR is required");
const inputs = await loadNativeImageInputs(claudeEnvironment);
const rendered = renderNativeImageDockerfile(sandboxRuntimeLayout("cube"), inputs);
await mkdir(out, { recursive: true });
for (const file of rendered.files) {
  await mkdir(join(out, file.contextPath, ".."), { recursive: true });
  await writeFile(join(out, file.contextPath), file.bytes);
}
await writeFile(join(out, "Dockerfile"), rendered.dockerfile);
await writeFile(join(out, "name"), `${nativeImageName(inputs)}\n`);
console.log(`${nativeImageName(inputs)} rendered to ${out} (${rendered.files.length} context files)`);
