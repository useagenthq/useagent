import type { Metadata } from 'next';

import { AppShell } from '@/components/shell/app-shell';
import { ChatSidebar } from '@/components/shell/chat-sidebar';
import { ReviewWorkspace } from './review-workspace';

export const metadata: Metadata = {
  title: 'Review - skynet-a',
  description:
    'Verification-gated code review - grouped, adversarially-checked findings across your PRs.',
};

export default function ReviewPage() {
  return (
    <AppShell activeTab='code' sidebar={<ChatSidebar />}>
      <ReviewWorkspace />
    </AppShell>
  );
}
