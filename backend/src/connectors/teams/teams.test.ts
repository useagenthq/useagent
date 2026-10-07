import { describe, it, expect } from 'vitest';
import { TeamsTransport } from './transport';

describe('TeamsTransport', () => {
  it('should deny by default when unconfigured', () => {
    const transport = new TeamsTransport({ appId: 'id', appSecret: 'secret' });
    expect(transport.authorize({
      channelType: 'teams',
      userId: 'user1',
      conversationId: 'conv1',
      text: 'hello',
      attachments: [],
      isMention: true,
    })).toBe(false);
  });

  it('should authorize allowed users', () => {
    const transport = new TeamsTransport({
      appId: 'id',
      appSecret: 'secret',
      allowedUsers: ['user1'],
    });
    expect(transport.authorize({
      channelType: 'teams',
      userId: 'user1',
      conversationId: 'conv1',
      text: 'hello',
      attachments: [],
      isMention: true,
    })).toBe(true);
  });
});
