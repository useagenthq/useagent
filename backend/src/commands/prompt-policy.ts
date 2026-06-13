export const RUN_PROMPT_MAX_CHARS = 64_000;
export const RUN_PROMPT_MAX_BYTES = 128 * 1024;

export class RunPromptTooLargeError extends Error {
  readonly code = "prompt_too_large";

  constructor() {
    super("run prompt exceeds the accepted size limit");
  }
}

export function assertRunPromptLimit(prompt: string): void {
  if (
    prompt.length > RUN_PROMPT_MAX_CHARS ||
    new TextEncoder().encode(prompt).byteLength > RUN_PROMPT_MAX_BYTES
  ) {
    throw new RunPromptTooLargeError();
  }
}
