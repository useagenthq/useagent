import { randomUUID } from "node:crypto";
import { parseCodexSubscriptionFrame } from "./codex-subscription-protocol";

const MAX_BUFFERED_FRAMES = 256;
const MAX_BUFFERED_BYTES = 1_048_576;
const textEncoder = new TextEncoder();

type BootstrapState =
  | { readonly phase: "waiting-for-initialize" }
  | { readonly phase: "waiting-for-initialize-response"; readonly initializeId: string | number }
  | { readonly phase: "waiting-for-initialized" }
  | {
      readonly phase: "registering";
      readonly registrationId: string;
      readonly bufferedFrames: string[];
      bufferedBytes: number;
    }
  | { readonly phase: "ready" }
  | { readonly phase: "failed"; readonly error: Error };

export interface CodexRemoteEnvironmentBootstrap {
  acceptClientFrame(frame: string): Promise<readonly string[]>;
  acceptServerFrame(frame: string): Promise<readonly string[]>;
  close(): void;
}

export function createCodexRemoteEnvironmentBootstrap(input: {
  readonly environmentId: string;
  readonly execServerUrl: string;
  readonly connectTimeoutMs?: number;
  readonly requestId?: () => string;
}): CodexRemoteEnvironmentBootstrap {
  const ready = Promise.withResolvers<void>();
  // A failure may arrive before T3 has queued a dependent frame. Keep the
  // promise observed while preserving rejection for every later awaiter.
  void ready.promise.catch(() => {});
  const requestId = input.requestId ?? randomUUID;
  let state: BootstrapState = { phase: "waiting-for-initialize" };

  function fail(error: Error): Error {
    state = { phase: "failed", error };
    ready.reject(error);
    return error;
  }

  return {
    async acceptClientFrame(frame) {
      const parsed = parseCodexSubscriptionFrame(frame);
      if (parsed.method === "initialize") {
        if (state.phase !== "waiting-for-initialize") {
          throw new Error("Codex app-server initialize may be sent only once");
        }
        if (parsed.id === undefined || parsed.hasResponse) {
          throw new Error("Codex app-server initialize request id is required");
        }
        state = {
          phase: "waiting-for-initialize-response",
          initializeId: parsed.id,
        };
        return [frame];
      }

      if (state.phase === "waiting-for-initialized") {
        if (parsed.method !== "initialized") {
          throw new Error("Codex initialized notification is required before other requests");
        }
        if (parsed.id !== undefined || parsed.hasResponse) {
          throw new Error("Codex initialized notification is invalid");
        }
        const registrationId = requestId();
        if (!registrationId) {
          throw fail(new Error("Codex environment registration id is required"));
        }
        state = {
          phase: "registering",
          registrationId,
          bufferedFrames: [],
          bufferedBytes: 0,
        };
        return [
          frame,
          JSON.stringify({
            id: registrationId,
            method: "environment/add",
            params: {
              environmentId: input.environmentId,
              execServerUrl: input.execServerUrl,
              connectTimeoutMs: input.connectTimeoutMs ?? 15_000,
            },
          }),
        ];
      }

      if (state.phase === "ready") return [frame];
      if (state.phase === "failed") throw state.error;
      if (state.phase === "waiting-for-initialize") {
        throw new Error("Codex app-server initialize is required before other requests");
      }
      if (state.phase === "waiting-for-initialize-response") {
        throw new Error("Codex initialize response is required before other requests");
      }
      await ready.promise;
      return [frame];
    },

    async acceptServerFrame(frame) {
      const parsed = parseCodexSubscriptionFrame(frame);
      if (
        state.phase === "waiting-for-initialize-response" &&
        parsed.id === state.initializeId
      ) {
        if (parsed.method !== undefined || !parsed.hasResponse) {
          throw fail(new Error("Codex app-server initialize response is invalid"));
        }
        if (parsed.hasError) {
          fail(new Error("Codex app-server initialize failed"));
          return [frame];
        }
        state = { phase: "waiting-for-initialized" };
        return [frame];
      }

      if (state.phase === "registering" && parsed.id === state.registrationId) {
        if (parsed.method !== undefined || !parsed.hasResponse) {
          throw fail(new Error("Codex remote environment registration response is invalid"));
        }
        if (parsed.hasError) {
          throw fail(new Error("Codex remote environment registration failed"));
        }
        const bufferedFrames = state.bufferedFrames;
        state = { phase: "ready" };
        ready.resolve();
        return bufferedFrames;
      }

      if (state.phase === "registering") {
        const frameBytes = textEncoder.encode(frame).byteLength;
        if (
          state.bufferedFrames.length >= MAX_BUFFERED_FRAMES ||
          state.bufferedBytes + frameBytes > MAX_BUFFERED_BYTES
        ) {
          throw fail(new Error("Codex environment registration buffer limit exceeded"));
        }
        state.bufferedFrames.push(frame);
        state.bufferedBytes += frameBytes;
        return [];
      }

      return [frame];
    },

    close() {
      if (state.phase === "ready" || state.phase === "failed") return;
      fail(new Error("Codex remote environment bootstrap closed"));
    },
  };
}
