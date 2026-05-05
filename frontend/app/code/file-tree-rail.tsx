import {
  RiFileCodeLine,
  RiFileTextLine,
  RiFolder3Fill,
  RiReactjsLine,
} from '@remixicon/react';
import type { ComponentType } from 'react';

import { cn } from '@/utils/cn';

type IconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

interface FileNode {
  name: string;
  icon: IconComponent;
  depth: number;
  active?: boolean;
}

interface FolderNode {
  name: string;
  depth: number;
}

type TreeRow =
  | ({ kind: 'folder' } & FolderNode)
  | ({ kind: 'file' } & FileNode);

/** Static project tree — a stand-in for the agent's live workspace. */
const tree: TreeRow[] = [
  { kind: 'folder', name: 'app', depth: 0 },
  { kind: 'file', name: 'layout.tsx', icon: RiReactjsLine, depth: 1 },
  { kind: 'file', name: 'page.tsx', icon: RiReactjsLine, depth: 1 },
  { kind: 'folder', name: 'components', depth: 1 },
  {
    kind: 'file',
    name: 'run-trace.tsx',
    icon: RiReactjsLine,
    depth: 2,
    active: true,
  },
  { kind: 'file', name: 'step-row.tsx', icon: RiReactjsLine, depth: 2 },
  { kind: 'file', name: 'terminal.tsx', icon: RiReactjsLine, depth: 2 },
  { kind: 'folder', name: 'lib', depth: 0 },
  { kind: 'file', name: 'agent.ts', icon: RiFileCodeLine, depth: 1 },
  { kind: 'file', name: 'stream.ts', icon: RiFileCodeLine, depth: 1 },
  { kind: 'file', name: 'package.json', icon: RiFileTextLine, depth: 0 },
  { kind: 'file', name: 'README.md', icon: RiFileTextLine, depth: 0 },
];

export function FileTreeRail() {
  return (
    <aside
      aria-label='File tree'
      className='flex w-64 shrink-0 flex-col border-r border-stroke-soft-200 bg-bg-white-0'
    >
      <div className='flex items-center gap-2 border-b border-stroke-soft-200 px-4 py-3.5'>
        <RiFolder3Fill className='size-4 text-text-soft-400' aria-hidden />
        <span className='text-label-sm text-text-strong-950'>skynet-app</span>
      </div>
      <nav className='min-h-0 flex-1 overflow-y-auto p-2'>
        {tree.map((row) => {
          const pad = { paddingLeft: `${row.depth * 14 + 8}px` };
          if (row.kind === 'folder') {
            return (
              <div
                key={`${row.name}-${row.depth}`}
                style={pad}
                className='flex items-center gap-2 rounded-lg py-1.5 pr-2 text-label-sm text-text-sub-600'
              >
                <RiFolder3Fill
                  className='size-4 shrink-0 text-text-soft-400'
                  aria-hidden
                />
                {row.name}
              </div>
            );
          }
          const Icon = row.icon;
          return (
            <div
              key={`${row.name}-${row.depth}`}
              style={pad}
              aria-current={row.active ? 'true' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-lg py-1.5 pr-2 text-label-sm transition-colors',
                row.active
                  ? 'bg-bg-weak-50 text-text-strong-950'
                  : 'text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950',
              )}
            >
              <Icon
                className={cn(
                  'size-4 shrink-0',
                  row.active ? 'text-primary-base' : 'text-text-soft-400',
                )}
                aria-hidden
              />
              {row.name}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
