import type { Metadata } from 'next';

import { AppShell } from '@/components/shell/app-shell';
import { ChatSidebar } from '@/components/shell/chat-sidebar';
import { ChatView } from '@/components/chat/chat-view';

export const metadata: Metadata = {
  title: 'Chat',
  description: 'Talk to the model directly - instant, no sandbox.',
};

/**
 * Home is the lightweight Chat surface (#122): a no-sandbox conversational page
 * that streams a model completion directly, augmented with read-only retrieval
 * (org knowledge + wiki + team memory) and a Promote to Agent action. Distinct
 * from the Agent surface (/agent/runs), which spins Daytona sandboxes.
 */
export default function Home() {
  return (
    <AppShell activeTab='chat' sidebar={<ChatSidebar active='new-chat' />}>
      <ChatView />
    </AppShell>
  );
}
