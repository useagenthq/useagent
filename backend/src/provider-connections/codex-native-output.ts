import { createHash } from "node:crypto";

interface JsonRecord {
  [key: string]: unknown;
}

export interface CodexNativeImageCandidate {
  readonly sourceKey: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly savedPath: string;
}

export interface PreparedCodexServerFrame {
  readonly frame: string;
  readonly image: CodexNativeImageCandidate | null;
}

const MAX_REVISED_PROMPT_CHARS = 16_384;
const MAX_ID_CHARS = 1_024;
const IMAGE_METHODS = new Set(["item/started", "item/completed"]);
const IMAGE_STATUSES = new Set(["inProgress", "completed", "failed"]);

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function boundedString(value: unknown, maxChars = MAX_ID_CHARS): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length <= maxChars ? trimmed : "";
}

function sourceKey(threadId: string, turnId: string, itemId: string): string {
  const hash = createHash("sha256");
  for (const part of [threadId, turnId, itemId]) {
    hash.update(String(Buffer.byteLength(part)));
    hash.update(":");
    hash.update(part);
  }
  return hash.digest("hex");
}

/**
 * Extract the trusted host locator from a completed Codex image-generation
 * notification, then remove every path-bearing opaque field before the frame
 * crosses into T3. This function never reads the host path and never turns a
 * provider result string into product data.
 */
export function prepareCodexServerFrame(frame: string): PreparedCodexServerFrame {
  let parsed: JsonRecord;
  try {
    const value = record(JSON.parse(frame));
    if (!value) return { frame, image: null };
    parsed = value;
  } catch {
    return { frame, image: null };
  }

  const params = record(parsed.params);
  const item = record(params?.item);
  if (item?.type !== "imageGeneration") return { frame, image: null };

  const threadId = boundedString(params?.threadId);
  const turnId = boundedString(params?.turnId);
  const itemId = boundedString(item.id);
  const savedPath = boundedString(item.savedPath, 4_096);
  const method = typeof parsed.method === "string" && IMAGE_METHODS.has(parsed.method)
    ? parsed.method
    : null;
  const status = typeof item.status === "string" && IMAGE_STATUSES.has(item.status)
    ? item.status
    : null;
  const completed = method === "item/completed" && status === "completed";
  const image = completed && savedPath && threadId && turnId && itemId
    ? { sourceKey: sourceKey(threadId, turnId, itemId), threadId, turnId, itemId, savedPath }
    : null;

  // Rebuild from a strict whitelist. `result` and every unknown provider field
  // are opaque and may contain a host path, URL, credentials, or a large blob.
  const sanitizedItem: JsonRecord = {
    type: "imageGeneration",
    ...(itemId ? { id: itemId } : {}),
    ...(status ? { status } : {}),
    ...(typeof item.revisedPrompt === "string"
      ? { revisedPrompt: item.revisedPrompt.slice(0, MAX_REVISED_PROMPT_CHARS) }
      : {}),
  };
  const sanitizedParams: JsonRecord = {
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    item: sanitizedItem,
  };
  return {
    frame: JSON.stringify({ ...(method ? { method } : {}), params: sanitizedParams }),
    image,
  };
}
