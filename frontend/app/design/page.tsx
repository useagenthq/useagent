import type { Metadata } from 'next';

import { AppShell } from '@/components/shell/app-shell';
import { ChatSidebar } from '@/components/shell/chat-sidebar';
import { DesignGallery } from './design-gallery';

export const metadata: Metadata = {
  title: 'Design - skynet-a',
  description: 'Your design canvas - frames Skynet is shaping with you.',
};

export default function DesignPage() {
  return (
    <AppShell activeTab='design' sidebar={<ChatSidebar />}>
      <DesignGallery />
    </AppShell>
  );
}
