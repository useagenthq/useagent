import { toolGatewayConfig, type ToolGatewayConfig } from "./config";
import {
  mintToolToken,
  type ToolTokenClaims,
  type ToolTokenScope,
} from "./token";

export interface ToolCallTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ToolCallImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type ToolCallContent = ToolCallTextContent | ToolCallImageContent;

export interface ToolCallResult<Content extends ToolCallContent = ToolCallTextContent> {
  readonly content: readonly Content[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

export interface GatewayToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type GatewayToolExecutor = (
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolCallResult<ToolCallContent>>;

export const TOOL_GATEWAY_SERVER_NAME = "skynet-knowledge";

export interface ToolGatewayBindingInput {
  readonly orgId?: string | null;
  readonly userId?: string | null;
  readonly threadId?: string | null;
  readonly runId: string;
}

export interface ToolGatewayBoundIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly scope: ToolTokenScope;
}

export interface ToolGatewayCapabilityDescriptor {
  readonly serverName: typeof TOOL_GATEWAY_SERVER_NAME;
  readonly url: string;
  readonly bearerToken: string;
  readonly authorizationHeader: string;
  readonly expiresAt: number;
  readonly binding: ToolGatewayBoundIdentity;
}

export interface BuildToolGatewayCapabilityOptions {
  readonly config?: ToolGatewayConfig | null;
  readonly scope?: ToolTokenScope;
  readonly ttlMs?: number;
  readonly nowMs?: number;
}

export interface DescribeToolGatewayCapabilityOptions {
  readonly config?: ToolGatewayConfig | null;
  readonly scope?: ToolTokenScope;
  readonly bearerToken: string;
  readonly expiresAt: number;
}

export interface AcpKnowledgeMcpServer {
  readonly [key: string]: unknown;
  readonly type: "http";
  readonly name: typeof TOOL_GATEWAY_SERVER_NAME;
  readonly url: string;
  readonly headers: readonly [{ readonly name: "Authorization"; readonly value: string }];
}

export interface OpenCodeKnowledgeMcpEntry {
  readonly [key: string]: unknown;
  readonly type: "remote";
  readonly url: string;
  readonly enabled: true;
  readonly headers: { readonly Authorization: string };
}

export interface CodexToolGatewayConfig {
  readonly url: string;
  readonly bearerToken: string;
}

export function buildToolGatewayCapabilityDescriptor(
  binding: ToolGatewayBindingInput,
  options: BuildToolGatewayCapabilityOptions = {},
): ToolGatewayCapabilityDescriptor | null {
  const config = options.config === undefined ? toolGatewayConfig() : options.config;
  const orgId = binding.orgId?.trim();
  if (!config || !orgId) return null;

  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = Math.min(options.ttlMs ?? config.tokenTtlMs, config.tokenTtlMs);
  const scope = options.scope ?? "run";
  const bound: ToolGatewayBoundIdentity = {
    orgId,
    userId: binding.userId ?? "",
    threadId: binding.threadId || binding.runId,
    runId: binding.runId,
    scope,
  };
  const bearerToken = mintToolToken(bound, ttlMs, nowMs);
  return {
    serverName: TOOL_GATEWAY_SERVER_NAME,
    url: config.mcpUrl,
    bearerToken,
    authorizationHeader: `Bearer ${bearerToken}`,
    expiresAt: nowMs + ttlMs,
    binding: bound,
  };
}

export function describeToolGatewayCapabilityDescriptor(
  binding: ToolGatewayBindingInput,
  options: DescribeToolGatewayCapabilityOptions,
): ToolGatewayCapabilityDescriptor | null {
  const config = options.config === undefined ? toolGatewayConfig() : options.config;
  const orgId = binding.orgId?.trim();
  if (!config || !orgId) return null;
  const bound: ToolGatewayBoundIdentity = {
    orgId,
    userId: binding.userId ?? "",
    threadId: binding.threadId || binding.runId,
    runId: binding.runId,
    scope: options.scope ?? "run",
  };
  return {
    serverName: TOOL_GATEWAY_SERVER_NAME,
    url: config.mcpUrl,
    bearerToken: options.bearerToken,
    authorizationHeader: `Bearer ${options.bearerToken}`,
    expiresAt: options.expiresAt,
    binding: bound,
  };
}

export function toAcpKnowledgeMcpServer(
  descriptor: ToolGatewayCapabilityDescriptor,
): AcpKnowledgeMcpServer {
  return {
    type: "http",
    name: descriptor.serverName,
    url: descriptor.url,
    headers: [{ name: "Authorization", value: descriptor.authorizationHeader }],
  };
}

export function toOpenCodeKnowledgeMcpEntry(
  descriptor: ToolGatewayCapabilityDescriptor,
): OpenCodeKnowledgeMcpEntry {
  return {
    type: "remote",
    url: descriptor.url,
    enabled: true,
    headers: { Authorization: descriptor.authorizationHeader },
  };
}

export function toCodexToolGatewayConfig(
  descriptor: ToolGatewayCapabilityDescriptor,
): CodexToolGatewayConfig {
  return {
    url: descriptor.url,
    bearerToken: descriptor.bearerToken,
  };
}
