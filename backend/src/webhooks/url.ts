import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blockedAddresses = new BlockList();

for (const [subnet, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(subnet, prefix, "ipv4");
}

for (const [subnet, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(subnet, prefix, "ipv6");
}

const blockedHostSuffixes = [
  ".localhost",
  ".local",
  ".internal",
  ".test",
  ".invalid",
  ".example",
  ".home.arpa",
];

export interface WebhookDestination {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
}

export function isPublicAddress(address: string, family: number): boolean {
  if (isIP(address) !== family || (family !== 4 && family !== 6)) return false;
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) return false;
  return !blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function parseWebhookUrl(value: string): URL | null {
  if (!value || value.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    isIP(hostname) !== 0 ||
    !hostname.includes(".") ||
    blockedHostSuffixes.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))
  ) {
    return null;
  }

  return url;
}

export async function resolveWebhookDestination(value: string): Promise<WebhookDestination> {
  const url = parseWebhookUrl(value);
  if (!url) throw new Error("invalid_webhook_url");

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
    throw new Error("webhook_host_not_public");
  }

  const destination = addresses[0];
  if (!destination || (destination.family !== 4 && destination.family !== 6)) {
    throw new Error("webhook_host_not_public");
  }
  return { url, address: destination.address, family: destination.family };
}
