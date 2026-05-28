import type { RunResource } from "./types";

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY_RE = /^[A-Za-z0-9._-]{1,100}$/u;

export function parseExactGitHubRepositoryUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const parts = url.pathname.replace(/\/$/u, "").split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0] ?? "";
  const name = (parts[1] ?? "").replace(/\.git$/iu, "");
  if (
    !OWNER_RE.test(owner) ||
    !REPOSITORY_RE.test(name) ||
    name === "." ||
    name === ".."
  ) {
    return null;
  }
  return `${owner}/${name}`;
}

export function hasExactGitHubRepositoryUrlProvenance(resource: RunResource): boolean {
  if (resource.kind !== "code.repository") return false;
  return resource.provenance.some((provenance) => {
    if (provenance.source !== "user_text") return false;
    const repository = parseExactGitHubRepositoryUrl(provenance.raw);
    return repository === resource.locator.repository;
  });
}

/** A repository companion synthesized from a PR URL binds that exact change;
 * it does not grant checkout or repository-wide reads. Those broader actions
 * require an explicit selection, inherited checkout scope, or an exact repo URL. */
export function hasGitHubRepositoryCheckoutIntent(resource: RunResource): boolean {
  if (resource.kind !== "code.repository") return false;
  return resource.provenance.some((provenance) => {
    if (provenance.source !== "user_text") return true;
    return parseExactGitHubRepositoryUrl(provenance.raw) === resource.locator.repository;
  });
}
