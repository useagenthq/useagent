const HAN_CHARACTERS = /\p{Script=Han}/gu;
const LATIN_CHARACTERS = /\p{Script=Latin}/gu;

export const LATIN_MIN_CHARACTERS = 20;
export const LATIN_MIN_LATIN_TO_HAN_RATIO = 4;
export const CHINESE_MIN_HAN_CHARACTERS = 4;
export const CHINESE_MIN_HAN_TO_LATIN_RATIO = 1;
export const MEANINGFUL_HAN_OUTPUT_CHARACTERS = 2;

export const LATIN_RETRY_INSTRUCTION =
  "Correction: preserve the exact source language; do not translate. Return scene_name and memory content in that same source language, with no Chinese Han text.";

export class LanguagePolicyError extends Error {
  constructor() {
    super("L1 extraction remained Chinese after the source-language retry");
    this.name = "LanguagePolicyError";
  }
}

export interface LanguagePolicyScene {
  scene_name: string;
  memories: Array<{ content: string }>;
}

export interface LanguagePolicySourceMessage {
  role?: string;
  content: string;
}

export type SourceScript = "latin" | "chinese" | "mixed" | "unknown";

function naturalLanguageText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/\b[A-Za-z][A-Za-z0-9]*(?:[_./:#@-][A-Za-z0-9_$-]+)+\b/g, " ")
    .replace(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*)+)\b/g, " ")
    .replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, " ");
}

function scriptCounts(text: string): { latin: number; han: number } {
  const normalized = naturalLanguageText(text);
  return {
    latin: normalized.match(LATIN_CHARACTERS)?.length ?? 0,
    han: normalized.match(HAN_CHARACTERS)?.length ?? 0,
  };
}

export function sourceHanSpans(sourceMessages: readonly LanguagePolicySourceMessage[]): string[] {
  const userMessages = sourceMessages.filter((message) => message.role === "user");
  const selectedMessages = userMessages.length > 0 ? userMessages : sourceMessages;
  const spans = selectedMessages
    .flatMap((message) => message.content.match(/\p{Script=Han}{2,}/gu) ?? []);
  return [...new Set(spans)].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function removeAllowedHanSpans(text: string, allowedHanSpans: readonly string[]): string {
  return allowedHanSpans.reduce((remaining, span) => remaining.split(span).join(""), text);
}

export function buildLatinRetryInstruction(allowedHanSpans: readonly string[]): string {
  if (allowedHanSpans.length === 0) return LATIN_RETRY_INSTRUCTION;
  return `${LATIN_RETRY_INSTRUCTION} Preserve these source Han spans verbatim without translating or altering them: ${allowedHanSpans.join(", ")}.`;
}

export function classifySourceScript(sourceMessages: readonly LanguagePolicySourceMessage[]): SourceScript {
  const userMessages = sourceMessages.filter((message) => message.role === "user");
  const selectedMessages = userMessages.length > 0 ? userMessages : sourceMessages;
  const { latin, han } = scriptCounts(selectedMessages.map((message) => message.content).join("\n"));

  if (latin >= LATIN_MIN_CHARACTERS && latin >= han * LATIN_MIN_LATIN_TO_HAN_RATIO) {
    return "latin";
  }
  if (han >= CHINESE_MIN_HAN_CHARACTERS && han >= latin * CHINESE_MIN_HAN_TO_LATIN_RATIO) {
    return "chinese";
  }
  if (latin > 0 && han > 0) {
    return "mixed";
  }
  return "unknown";
}

export function sourceRequiresLatinOutput(sourceMessages: readonly LanguagePolicySourceMessage[]): boolean {
  return classifySourceScript(sourceMessages) === "latin";
}

export function hasHanInL1FreeText(
  scenes: readonly LanguagePolicyScene[],
  allowedHanSpans: readonly string[] = [],
): boolean {
  return scenes.some(
    (scene) => scriptCounts(removeAllowedHanSpans(scene.scene_name, allowedHanSpans)).han >= MEANINGFUL_HAN_OUTPUT_CHARACTERS
      || scene.memories.some(
        (memory) => scriptCounts(removeAllowedHanSpans(memory.content, allowedHanSpans)).han >= MEANINGFUL_HAN_OUTPUT_CHARACTERS,
      ),
  );
}

export async function extractWithLanguagePolicy<T extends LanguagePolicyScene>(params: {
  sourceMessages: readonly LanguagePolicySourceMessage[];
  extract: (correctionInstruction?: string) => Promise<T[]>;
}): Promise<T[]> {
  const allowedHanSpans = sourceHanSpans(params.sourceMessages);
  const firstResult = await params.extract();
  if (!sourceRequiresLatinOutput(params.sourceMessages) || !hasHanInL1FreeText(firstResult, allowedHanSpans)) {
    return firstResult;
  }

  const retryResult = await params.extract(buildLatinRetryInstruction(allowedHanSpans));
  if (hasHanInL1FreeText(retryResult, allowedHanSpans)) {
    throw new LanguagePolicyError();
  }
  return retryResult;
}
