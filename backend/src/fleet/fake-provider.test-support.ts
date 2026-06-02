import type {
  SandboxCreateOptions,
  SandboxFileSystem,
  SandboxHandle,
  SandboxInventory,
  SandboxPreviewLink,
  SandboxProcess,
  SandboxProvider,
} from "@useagent/sandbox-contract";

// ---------------------------------------------------------------------------
// Provider TEST DOUBLE implementing the full sandbox contract INCLUDING the
// optional inventory() telemetry method — so capacity/admission tests run with
// zero live Cube/Daytona. It records created + deleted sandbox ids (to assert
// provider reconciliation) and returns a configurable inventory snapshot.
// ---------------------------------------------------------------------------

function fakeHandle(id: string, del: () => void): SandboxHandle {
  return {
    id,
    cpu: 2,
    memory: 8,
    state: "started",
    labels: {},
    // Unused by capacity tests — present to satisfy the contract shape.
    process: {} as unknown as SandboxProcess,
    fs: {} as unknown as SandboxFileSystem,
    async start() {},
    async delete() {
      del();
    },
    async getPreviewLink(): Promise<SandboxPreviewLink> {
      return { url: `https://fake/${id}` };
    },
  };
}

export class FakeInventoryProvider implements SandboxProvider {
  readonly created: string[] = [];
  readonly deleted: string[] = [];
  private readonly boxes = new Map<string, SandboxHandle>();

  constructor(private snapshot: SandboxInventory = {}) {}

  setInventory(snapshot: SandboxInventory): void {
    this.snapshot = snapshot;
  }

  async create(_options?: SandboxCreateOptions): Promise<SandboxHandle> {
    const id = `fake-${this.created.length + 1}`;
    this.created.push(id);
    const handle = fakeHandle(id, () => {
      this.deleted.push(id);
      this.boxes.delete(id);
    });
    this.boxes.set(id, handle);
    return handle;
  }

  async get(sandboxId: string): Promise<SandboxHandle> {
    const existing = this.boxes.get(sandboxId);
    if (existing) return existing;
    // Return a handle so delete() is observable even for boxes we did not track.
    return fakeHandle(sandboxId, () => this.deleted.push(sandboxId));
  }

  async *list(): AsyncIterable<SandboxHandle> {
    for (const handle of this.boxes.values()) yield handle;
  }

  async inventory(): Promise<SandboxInventory> {
    return this.snapshot;
  }
}
