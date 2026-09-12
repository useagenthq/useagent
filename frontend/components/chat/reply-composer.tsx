"use client";

import type { EngineId, MemoryScope } from "@/components/chat/types";


import {
  type CommandCatalogState,
} from "@/components/chat/canonical-timeline";
import { Composer, type ComposerSubmit } from "@/components/chat/composer";
import type { SlashCommand } from "@/components/chat/slash-command";
export function ReplyComposer({
  engine,
  model,
  memoryScope,
  pending,
  commands,
  commandState,
  modelSelection,
  locked,
  placeholder,
  onReply,
  running,
  stopping,
  stopError,
  onStop,
  runStartedAt,
  threadError,
  onDismissThreadError,
  notice,
  onDismissNotice,
  engineUnavailable,
  engineUnavailableMessage,
  draftKey,
  prefill,
  enableMentions,
  enableUploads,
  repoRevisions,
}: {
  engine: EngineId;
  model: string;
  memoryScope: MemoryScope;
  pending: boolean;
  commands?: SlashCommand[];
  commandState?: CommandCatalogState;
  /** The session's negotiated model-selection capability - the per-message model picker shows ONLY
   *  when the engine actually lets the user choose (opencode); ACP engines run a fixed model. */
  modelSelection?: boolean;
  locked?: boolean;
  placeholder?: string;
  onReply: ComposerSubmit;
  running?: boolean;
  stopping?: boolean;
  stopError?: string | null;
  onStop?: () => void;
  runStartedAt?: string | null;
  threadError?: string | null;
  onDismissThreadError?: () => void;
  /** A notice about the last accepted reply (a bot that did not get it). */
  notice?: string | null;
  onDismissNotice?: () => void;
  engineUnavailable?: boolean;
  engineUnavailableMessage?: string;
  /** Thread key for per-thread draft persistence (the root run id). */
  draftKey?: string | null;
  /** Externally seed the composer (conflicted-proposal "Ask agent to redo"). */
  prefill?: { readonly text: string; readonly nonce: number } | null;
  enableMentions?: boolean;
  enableUploads?: boolean;
  repoRevisions?: Readonly<Record<string, string | null>>;
}) {
  return (
    <div className="shrink-0 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
      {/* Full column width, like the timeline above it: the two edges line up
          however wide the conversation is dragged. */}
      <div className="w-full">
        <Composer
          variant="compact"
          placeholder={placeholder}
          placeholderLead="Reply to Agent"
          defaultEngine={engine}
          defaultModel={model}
          defaultMemoryScope={memoryScope}
          pending={pending}
          locked={locked}
          commands={commands} commandState={commandState}
          enableUploads={enableUploads}
          enableMentions={enableMentions}
          repoRevisions={repoRevisions}
          enableModelPicker={modelSelection === true}
          onSubmit={onReply}
          running={running}
          stopping={stopping}
          stopError={stopError}
          onStop={onStop}
          runStartedAt={runStartedAt}
          threadError={threadError}
          onDismissThreadError={onDismissThreadError}
          notice={notice}
          onDismissNotice={onDismissNotice}
          engineUnavailable={engineUnavailable}
          engineUnavailableMessage={engineUnavailableMessage}
          draftKey={draftKey}
          prefill={prefill}
        />
      </div>
    </div>
  );
}
