import type { Metadata } from 'next';

import { AppShell } from '@/components/shell/app-shell';
import { ChatSidebar } from '@/components/shell/chat-sidebar';
import { ComponentLab } from './component-lab';

export const metadata: Metadata = {
  title: 'Component lab — skynet-a',
  description: 'The parts bin for skynet-a — every vendored AlignUI primitive.',
};

export default function LabPage() {
  return (
    <AppShell activeTab='code' sidebar={<ChatSidebar />}>
      <ComponentLab />
    </AppShell>
  );
}
