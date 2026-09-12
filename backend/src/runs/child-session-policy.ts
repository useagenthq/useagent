export const CHILD_TITLE_MAX_CHARS = 160;
export const CHILD_PROMPT_MAX_CHARS = 4_000;
export const CHILD_CONTEXT_MAX_CHARS = 4_000;
export const CHILD_CONTEXT_MAX_BYTES = 16 * 1024;
export const CHILD_TRANSCRIPT_EVENT_LIMIT = 50;
export const CHILD_RESULT_MAX_CHARS = 4_000;
export const CHILD_REFERENCE_PAGE_LIMIT = 20;
export const CHILD_BATCH_LIMIT = 20;

export function boundedChildTitle(value: string): string {
  const title = value.trim();
  if (!title) throw new Error("child title is required");
  if (title.length > CHILD_TITLE_MAX_CHARS) {
    throw new Error(`child title exceeds ${CHILD_TITLE_MAX_CHARS} characters`);
  }
  return title;
}
