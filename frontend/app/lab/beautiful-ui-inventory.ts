export const BEAUTIFUL_UI_COMPONENTS = [
  "loading-state",
  "thinking-state",
  "streaming-text",
  "approval-card",
  "tool-chips",
  "task-rows",
  "chat-composer",
  "prompt-bar",
  "recommendation-card",
  "context-cards",
  "diff-table",
  "records-table",
  "filter-table",
  "sidebar-nav",
  "search",
  "insight-cards",
  "code-block",
  "fine-tune-card",
  "selection-actions",
] as const;

export type BeautifulUiComponent = (typeof BEAUTIFUL_UI_COMPONENTS)[number];
