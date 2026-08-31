import { productionComposeReleaseConfig } from "./release-config";

const config = productionComposeReleaseConfig(process.env);
console.log(JSON.stringify({
  ok: true,
  color: config.color,
  commit: config.commit,
  publicGatewayUrl: config.publicGatewayUrl,
  imageDigests: Object.fromEntries(
    Object.entries(config.images).map(([name, image]) => [name, image.split("@", 2)[1]]),
  ),
  ports: config.ports,
}));
