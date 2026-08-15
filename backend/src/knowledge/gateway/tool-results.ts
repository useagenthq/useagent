import type { ToolCallResult } from "./tools";

export function textResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): ToolCallResult {
  return { content: [{ type: "text", text }], structuredContent };
}

export function errorResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): ToolCallResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError: true,
  };
}
