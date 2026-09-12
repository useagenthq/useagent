/**
 * Org-authored text (bot names, titles, rules) that lands in a prompt must never
 * open or close a tag or break a line: escape the delimiters JSON leaves alone.
 */
export function promptSafeJson(value: unknown, pretty = false): string {
  return JSON.stringify(value, null, pretty ? 2 : undefined).replace(/[<>&\u2028\u2029]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
