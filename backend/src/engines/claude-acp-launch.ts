import {
  CLAUDE_MCP_CONFIG_FILE,
  CLAUDE_SETTINGS_FILE,
} from "../provider-gateway/sandbox-config";

export const CLAUDE_ACP_WRAPPER = "$HOME/.local/bin/useagent-claude";
const wrapper = [
  "#!/bin/sh",
  "set -eu",
  `exec "$HOME/.local/bin/claude" "$@" --settings ${JSON.stringify(CLAUDE_SETTINGS_FILE)} --mcp-config ${JSON.stringify(CLAUDE_MCP_CONFIG_FILE)}`,
  "",
].join("\n");
const encoded = Buffer.from(wrapper, "utf8").toString("base64");
export const CLAUDE_ACP_PRE_RELAY =
  `printf %s '${encoded}' | base64 -d > ${CLAUDE_ACP_WRAPPER} && chmod 700 ${CLAUDE_ACP_WRAPPER}; `;
