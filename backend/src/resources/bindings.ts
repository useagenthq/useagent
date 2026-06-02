import { createHash } from "node:crypto";
import { parseRepoRef } from "../github/repo-ref";
import type { RunResource } from "./types";

function bindingKey(resource: RunResource): string {
  switch (resource.locator.type) {
    case "github.repository":
      return `github:repository:${resource.locator.repository.toLowerCase()}:${resource.locator.revision ?? ""}`;
    case "github.pull_request":
      return `github:pull:${resource.locator.repository.toLowerCase()}:${resource.locator.number}:${resource.locator.revision ?? ""}`;
    case "file":
      return `${resource.provider}:file:${resource.locator.id}`;
    case "web.page":
      return `${resource.provider}:page:${resource.locator.url}`;
  }
}

export function runResourceBindingId(runId: string, resource: RunResource): string {
  const digest = createHash("sha256")
    .update(`${runId}\0${bindingKey(resource)}`)
    .digest("base64url")
    .slice(0, 24);
  return `rb_${digest}`;
}

export function resourcesWithLegacyRepositories(input: {
  readonly resources: readonly RunResource[];
  readonly repos: readonly string[];
}): RunResource[] {
  const resources = [...input.resources];
  const present = new Set(
    resources.flatMap((resource) =>
      resource.locator.type === "github.repository"
        ? [resource.locator.repository.toLowerCase()]
        : [],
    ),
  );
  for (const encoded of input.repos) {
    const { repo, branch } = parseRepoRef(encoded);
    if (present.has(repo.toLowerCase())) continue;
    resources.push({
      kind: "code.repository",
      provider: "github",
      locator: { type: "github.repository", repository: repo, revision: branch },
      capabilities: ["content.read", "code.checkout"],
      // Legacy rows did not persist ingress provenance. Keep it unknown rather
      // than inventing a channel while projecting the old authorization.
      provenance: [],
    });
  }
  return resources;
}
