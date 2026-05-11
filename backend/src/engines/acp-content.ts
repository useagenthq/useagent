/** Normalize ACP tool output across agents. Claude commonly emits nested
 * `content` text blocks, while Codex may emit the same result in `rawOutput`.
 * Keep this provider asymmetry at the adapter boundary so every downstream
 * step, canonical event, and UI surface receives one stable string contract. */
export function extractAcpToolOutput(
  content: unknown,
  rawOutput: unknown,
  maxLength = 2_000,
): string {
  if (Array.isArray(content)) {
    const parts = content.flatMap((block): string[] => {
      if (!block || typeof block !== "object") return [];
      const value = block as {
        text?: string;
        content?: { text?: string };
      };
      const text =
        typeof value.content?.text === "string"
          ? value.content.text
          : typeof value.text === "string"
            ? value.text
            : "";
      return text ? [text] : [];
    });
    if (parts.length > 0) return parts.join("\n").slice(0, maxLength);
  }

  if (typeof rawOutput === "string") return rawOutput.slice(0, maxLength);
  if (rawOutput && typeof rawOutput === "object") {
    try {
      return JSON.stringify(rawOutput).slice(0, maxLength);
    } catch {
      return "";
    }
  }
  return "";
}
