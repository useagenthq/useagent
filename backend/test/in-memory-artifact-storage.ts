import { createHash } from "node:crypto";
import type {
  ArtifactByteRange,
  ArtifactStorage,
} from "../src/artifacts/storage";

export class InMemoryArtifactStorage implements ArtifactStorage {
  readonly values = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (!this.values.has(key)) this.values.set(key, bytes.slice());
  }

  async read(key: string, range?: ArtifactByteRange): Promise<Uint8Array> {
    const bytes = this.values.get(key);
    if (!bytes) throw new Error("missing artifact");
    return range ? bytes.slice(range.start, range.end + 1) : bytes.slice();
  }

  async size(key: string): Promise<number> {
    const bytes = this.values.get(key);
    if (!bytes) throw new Error("missing artifact");
    return bytes.byteLength;
  }

  async sha256(key: string): Promise<string> {
    const bytes = this.values.get(key);
    if (!bytes) throw new Error("missing artifact");
    return createHash("sha256").update(bytes).digest("hex");
  }
}
