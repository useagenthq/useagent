import { expect, test } from "bun:test";
import type { SandboxCreateOptions, SandboxProvider } from "./provider";

export interface SandboxProviderConformanceFixture {
  provider: SandboxProvider;
  createOptions: SandboxCreateOptions;
  createdId: string;
  existingId: string;
  listedIds: readonly string[];
}

export function sandboxProviderConformance(
  providerName: string,
  fixture: () => SandboxProviderConformanceFixture,
): void {
  test(`${providerName} normalizes create, get, and list behind the provider contract`, async () => {
    const { provider, createOptions, createdId, existingId, listedIds } = fixture();

    const created = await provider.create(createOptions);
    const existing = await provider.get(existingId);
    const listed = [];
    for await (const sandbox of provider.list()) listed.push(sandbox.id);

    expect(created.id).toBe(createdId);
    expect(existing.id).toBe(existingId);
    expect(listed).toEqual([...listedIds]);
  });
}
