"use client";

import type { EngineId, MemoryScope } from "@/components/chat/types";


import {
  type CommandCatalogState,
} from "@/components/chat/canonical-timeline";
import { Composer, type ComposerSubmit } from "@/components/chat/composer";
import { ModelKeysContext } from "@/components/chat/catalog-model-picker";
import { StartFreePrompt, useStartFree } from "@/app/(workspace)/agent/new/start-free-prompt";
import type { ReactNode } from "react";
import type { SlashCommand } from "@/components/chat/slash-command";
import type { ThreadErrorResend } from "@/components/session-ui/thread-error-banner";
export function ReplyComposer({
  engine,
  model,
  reasoningEffort,
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
  threadErrorResend,
  notice,
  onDismissNotice,
  engineUnavailable,
  engineUnavailableMessage,
  draftKey,
  prefill,
  enableMentions,
  enableUploads,
  repoRevisions,
  lead,
  status,
  permission,
}: {
  engine: EngineId;
  model: string;
  /** The thread's current reasoning effort; null runs on the runtime's default. */
  reasoningEffort?: string | null;
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
  threadErrorResend?: ThreadErrorResend;
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
  /** Rendered above the input card (the running footer, the queued rows). */
  lead?: ReactNode;
  /** The status tray under the input card (where the run executes, branch,
   *  project, engine, spend, context meter). */
  status?: ReactNode;
  /** The permission chip for the footer's second column. */
  permission?: ReactNode;
}) {
  // The model picker below marks models no key of the member's serves; its
  // "Add key" actions open that provider's form here, above the input card.
  const keys = useStartFree();
  return (
    <div
      data-session-ui="reply-composer"
      className="shrink-0 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2"
    >
      {/* Full column width, like the timeline above it: the two edges line up
          however wide the conversation is dragged. */}
      <div className="w-full">
        {lead}
        {keys.formProvider ? (
          <StartFreePrompt
            formProvider={keys.formProvider}
            connection={keys.formConnection}
            onAdd={() => keys.openForm("openrouter")}
            onDismiss={keys.closeForm}
            onSaved={keys.saved}
          />
        ) : null}
        <ModelKeysContext value={keys.access}>
          <Composer
            variant="compact"
            placeholder={placeholder}
            placeholderLead="Reply to Agent"
            defaultEngine={engine}
            defaultModel={model}
            defaultReasoningEffort={reasoningEffort}
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
            threadErrorResend={threadErrorResend}
            notice={notice}
            onDismissNotice={onDismissNotice}
            engineUnavailable={engineUnavailable}
            engineUnavailableMessage={engineUnavailableMessage}
            draftKey={draftKey}
            prefill={prefill}
            tab={status}
            permission={permission}
          />
        </ModelKeysContext>
      </div>
    </div>
  );
}
