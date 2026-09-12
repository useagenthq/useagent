// Create the Daytona native snapshot from the native image the Cube lane pushed
// to the private registry. Daytona pulls the image, so the registry is
// registered in the org once (REGISTRY_USER / REGISTRY_PASS). The snapshot is
// org-scoped: the env key's org and every user connection in it can start from
// it after the operator selects the verified snapshot on their connection.
//
//   bun run scripts/bake-daytona-snapshot.ts --image registry.example/skynet-agent:<name> [--force]
//   bun run scripts/bake-daytona-snapshot.ts --check      # print the snapshot name
//
// Runs with the backend's env (DAYTONA_API_KEY, DAYTONA_API_URL).
import { importDaytonaSnapshot } from "@useagent/sandbox-daytona";
import { deploymentNativeImageName } from "../src/sandboxes/native-image";
import { daytonaApiConfig } from "../src/sandboxes/provider";
import { resolveSandboxResourceTarget } from "../src/engines/daytona-resources";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const name = deploymentNativeImageName();
if (process.argv.includes("--check")) {
  console.log(name);
  process.exit(0);
}
const image = argument("image");
if (!image) throw new Error("--image <registry image reference> is required");
const apiKey = process.env.DAYTONA_API_KEY?.trim();
if (!apiKey) throw new Error("DAYTONA_API_KEY is not set");
const username = process.env.REGISTRY_USER?.trim();
const password = process.env.REGISTRY_PASS;
const registry = username && password ? { url: image.split("/")[0]!, username, password } : undefined;
const status = await importDaytonaSnapshot(daytonaApiConfig(apiKey), {
  name,
  image,
  registry,
  resources: { ...resolveSandboxResourceTarget(), disk: 10 },
  force: process.argv.includes("--force"),
  log: (line) => console.log(`[bake] ${line}`),
});
if (status.state !== "active") {
  console.error(`[bake] ${name} failed: ${status.detail ?? status.state}`);
  process.exit(1);
}
console.log(`[bake] ${name} is active. Set RUNTIME_DAYTONA_SNAPSHOT=${name} (and DAYTONA_SNAPSHOT for the other lanes) for env-key runs; select this verified snapshot explicitly on user connections.`);
process.exit(0);
