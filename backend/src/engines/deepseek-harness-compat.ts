import type { NegotiatedCapabilities } from "@useagent/agent-harness/canonical";

export const DEEPSEEK_HARNESS_ACP_PACKAGE = "@deepseek-ai/dsh-acp-demo@0.1.1-rc.2";

export const DEEPSEEK_HARNESS_ACP_CAPABILITIES: NegotiatedCapabilities = {
  streamingText: false,
  reasoning: false,
  plans: false,
  toolProgress: false,
  fileDiffs: false,
  nativeChildProjection: false,
  gatewayChildSessions: false,
  approvals: false,
  questions: false,
  usage: false,
  modelSelection: false,
  commands: false,
  directTerminal: false,
  resume: false,
  load: false,
  close: false,
  stop: true,
  reconcile: false,
  desktop: false,
  nativeEmbed: false,
  knowledgeTools: false,
};

/**
 * Documentation-only contract for stock DeepSeek Harness ACP. It stays absent
 * from EngineId and every product registry until server-mediated credentials
 * and an immutable runtime canary exist.
 */
export const DEEPSEEK_HARNESS_COMPATIBILITY = {
  provider: "deepseek-harness",
  package: DEEPSEEK_HARNESS_ACP_PACKAGE,
  protocol: "acp-automation-only",
  fixedModel: "deepseek-v4-flash",
  productRegistered: false,
  ready: false,
  blocker: "server-mediated DeepSeek credentials and an immutable runtime canary are unavailable",
  capabilities: DEEPSEEK_HARNESS_ACP_CAPABILITIES,
} as const;
