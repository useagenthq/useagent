import type { Metadata } from 'next';

import { AppShell } from '@/components/shell/app-shell';
import { ChatSidebar } from '@/components/shell/chat-sidebar';
import { ReviewWorkspace } from './review-workspace';

export const metadata: Metadata = {
  title: 'Pull requests - skynet-a',
  description: 'Open pull requests across your connected GitHub repositories.',
};

export default function ReviewPage() {
  return (
    <AppShell activeTab='code' sidebar={<ChatSidebar />}>
      <ReviewWorkspace />
    </AppShell>
  );
}
