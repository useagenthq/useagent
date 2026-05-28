import { createHash } from "node:crypto";
import { env } from "../env";
import { DistilledRecord, type KnowledgeRecord, type SourceMeta } from "./schema";
import { buildDistillPrompt, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompts";

/**
 * Distillation core — ported from the knowledge service
 * (packages/distillation/src/distill.ts). The OpenRouter call, forced function
 * tool, grounding enforcement (refs + verbatim_signals must appear verbatim in
 * the source, ungrounded dropped + counted), and the worth_saving gate are
 * faithful to the reference. Adapted here to degrade to a STUB record when no
 * OPENROUTER_API_KEY is configured, so the whole pipeline still works keyless.
 */

// OpenAI-compatible function tool (OpenRouter). NOTE the enum deliberately omits
// "undistilled" — that status is a code-only stub marker, never model-chosen.
const DISTILL_FN = {
  type: "function",
  function: {
    name: "emit_knowledge_record",
    description: "Emit exactly one distilled knowledge record.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["qa", "reference", "policy", "definition", "decision", "outcome"],
        },
        status: { type: "string", enum: ["current", "unresolved", "superseded", "draft"] },
        title: { type: "string" },
        question: { type: "string" },
        summary: { type: "string" },
        body: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        refs: { type: "array", items: { type: "string" } },
        verbatim_signals: { type: "array", items: { type: "string" } },
        confidence: { type: "number" },
        valid_from: { type: ["string", "null"] },
        valid_until: { type: ["string", "null"] },
        worth_saving: { type: "boolean" },
      },
      required: ["kind", "status", "title", "question", "summary", "body", "confidence", "worth_saving"],
    },
  },
} as const;

export class DistillError extends Error {}

// Hard deadline for the OpenRouter call so a hung LLM never occupies a request
// forever. AbortSignal.timeout covers the WHOLE request including body read.
const DISTILL_TIMEOUT_MS = Number(process.env.DISTILL_TIMEOUT_MS) || 150_000;

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
  error?: { message?: string };
}

/** Enforce grounding + salience on a validated record. Mutates refs/signals in place. */
function enforceGrounding(
  record: DistilledRecord,
  canonicalSource: string,
  rawWorthSaving: boolean | undefined,
): { grounding: KnowledgeRecord["grounding"]; worthSaving: boolean } {
  // refs + verbatim_signals must appear verbatim in the source. Drop ungrounded
  // entries but SURFACE how many — never silently swallow.
  const hay = canonicalSource.toLowerCase();
  const keptRefs = record.refs.filter((r) => hay.includes(r.toLowerCase()));
  const keptSignals = record.verbatim_signals.filter((s) => hay.includes(s.toLowerCase()));
  const grounding = {
    refsDropped: record.refs.length - keptRefs.length,
    signalsDropped: record.verbatim_signals.length - keptSignals.length,
  };
  record.refs = keptRefs;
  record.verbatim_signals = keptSignals;
  // LLM salience verdict (default true if the model omitted it).
  return { grounding, worthSaving: rawWorthSaving !== false };
}

/**
 * Build a keyless STUB record: kind "reference", title from the first line,
 * status "undistilled", worth_saving true. Used when OPENROUTER_API_KEY is
 * absent OR the LLM call fails — the source is still captured and searchable.
 */
export function stubRecord(meta: SourceMeta, source: string): KnowledgeRecord {
  const firstLine = source.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? source.trim();
  const title = (firstLine || "Untitled").slice(0, 300);
  const body = source.trim() || title;
  return {
    meta,
    record: {
      kind: "reference",
      status: "undistilled",
      title,
      question: title,
      summary: body.slice(0, 400),
      body,
      entities: [],
      refs: [],
      verbatim_signals: [],
      confidence: 0,
      valid_from: null,
      valid_until: null,
    },
    grounding: { refsDropped: 0, signalsDropped: 0 },
    worthSaving: true,
    stub: true,
  };
}

/** Distill one canonical source into a validated, grounded record via OpenRouter. */
export async function distill(meta: SourceMeta, canonicalSource: string): Promise<KnowledgeRecord> {
  const apiKey = env.distill.apiKey;
  if (!apiKey) return stubRecord(meta, canonicalSource); // keyless degrade

  const res = await fetch(`${env.distill.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/skynet-saas/knowledge", // OpenRouter attribution
      "X-Title": "useAgent Knowledge",
    },
    body: JSON.stringify({
      model: env.distill.model,
      temperature: 0,
      max_tokens: 8000, // headroom for a full record; truncation fails loud (below), never silently
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildDistillPrompt(meta.source_type, canonicalSource) },
      ],
      tools: [DISTILL_FN],
      tool_choice: { type: "function", function: { name: DISTILL_FN.function.name } },
    }),
    signal: AbortSignal.timeout(DISTILL_TIMEOUT_MS),
  });
  if (!res.ok) throw new DistillError(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const body = (await res.json()) as ChatResponse;
  if (body.error) throw new DistillError(`openrouter error: ${body.error.message}`);

  // Never accept a truncated record: if the model hit the token limit, the record
  // is incomplete even if its JSON happens to parse.
  if (body.choices?.[0]?.finish_reason === "length") {
    throw new DistillError("distill output truncated (finish_reason=length) — record incomplete");
  }

  const call = body.choices?.[0]?.message?.tool_calls?.find(
    (c) => c.function?.name === DISTILL_FN.function.name,
  );
  const args = call?.function?.arguments;
  if (!args) throw new DistillError(`no tool call (finish_reason=${body.choices?.[0]?.finish_reason ?? "?"})`);

  let raw: unknown;
  try {
    raw = JSON.parse(args);
  } catch {
    throw new DistillError(`tool arguments were not valid JSON: ${args.slice(0, 160)}`);
  }

  const parsed = DistilledRecord.safeParse(raw);
  if (!parsed.success) throw new DistillError(`schema validation failed: ${parsed.error.message}`);
  const record = parsed.data;

  const { grounding, worthSaving } = enforceGrounding(
    record,
    canonicalSource,
    (raw as { worth_saving?: boolean }).worth_saving,
  );

  return { meta, record, grounding, worthSaving, stub: false };
}

/** Deterministic idempotency key: re-run only when source, recipe, or model changes. */
export function distillationKey(
  canonicalContentHash: string,
  sourceType: string,
  model = env.distill.model,
): string {
  return createHash("sha256")
    .update([canonicalContentHash, sourceType, PROMPT_VERSION, "schema-v2", model].join("|"))
    .digest("hex");
}

/** sha256 of the raw source text — the content hash re-ingest compares against. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Canonical text we embed + keyword-index. The whole record so no field is
 * underweighted — drives both dense and sparse retrieval.
 */
export function renderCanonical(k: KnowledgeRecord): string {
  const r = k.record;
  return [
    `[${r.kind}] ${r.title}`,
    `Q: ${r.question}`,
    `Summary: ${r.summary}`,
    `Body: ${r.body}`,
    r.entities.length ? `Entities: ${r.entities.join(", ")}` : "",
    r.verbatim_signals.length ? `Signals: ${r.verbatim_signals.join(" | ")}` : "",
    `Status: ${r.status}`,
    `Source: ${k.meta.source_type} ${k.meta.source_url ?? k.meta.external_id}`,
  ]
    .filter(Boolean)
    .join("\n");
}
