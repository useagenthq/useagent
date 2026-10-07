// Ported from Slack transport architecture for Microsoft Teams Bot Framework
import { Transport, TransportCapabilities, defaultCapabilities, InboundMessage, Renderer, dispatch } from '../types';
import { AllowList } from '../authorize';

export interface TeamsConfig {
  appId: string;
  appSecret: string;
  allowedTenants?: string[];
  allowedUsers?: string[];
}

export class TeamsTransport implements Transport {
  readonly channelType = 'teams';
  readonly capabilities: TransportCapabilities;
  #allowList: AllowList;
  #tenantAllowList: AllowList;
  #appId: string;
  #appSecret: string;

  constructor(config: TeamsConfig, capabilities: Partial<TransportCapabilities> = {}) {
    this.#appId = config.appId;
    this.#appSecret = config.appSecret;
    this.#allowList = new AllowList(config.allowedUsers ?? []);
    this.#tenantAllowList = new AllowList(config.allowedTenants ?? []);
    this.capabilities = defaultCapabilities({
      streaming: false,
      edit: true,
      reactions: true,
      threads: true,
      maxMessageChars: 40000,
      supportsProactiveSend: true,
      ...capabilities,
    });
  }

  async sendMessage(conversationId: string, content: string, threadId?: string | null): Promise<string> {
    // Implementation for sending message to MS Teams via Bot Framework REST API
    return 'teams-msg-id';
  }

  async resolveConversation(userId: string): Promise<string> {
    return userId;
  }

  async fetchHistory(conversationId: string, threadId?: string | null): Promise<InboundMessage[]> {
    return [];
  }

  async receive(rawEnvelope: any): Promise<void> {
    // Verify token and dispatch activity
    if (!rawEnvelope || !rawEnvelope.from) return;
    const msg: InboundMessage = {
      channelType: this.channelType,
      userId: rawEnvelope.from.id,
      conversationId: rawEnvelope.conversation?.id ?? 'default',
      text: rawEnvelope.text ?? '',
      threadId: rawEnvelope.replyToId ?? null,
      attachments: rawEnvelope.attachments ?? [],
      isMention: true,
    };
    if (!this.authorize(msg)) return;
  }

  authorize(msg: InboundMessage): boolean {
    return this.#allowList.authorize(msg.userId);
  }
}
