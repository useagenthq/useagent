"use client";

import { useState } from "react";
import {
  RiAddLine,
  RiArrowUpLine,
  RiMicLine,
  RiSendPlane2Line,
  RiToolsLine,
} from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";
import {
  PromptInput,
  PromptInputTextarea,
} from "@/components/prompt-kit/prompt-input";
import { Loader } from "@/components/prompt-kit/loader";
import { ModelPicker } from "@/components/chat/engine-picker";
import {
  AgentChip,
  ChooseAgentPopover,
  type Agent,
} from "@/components/chat/agent-command";
import type { EngineId } from "@/components/chat/types";

type Variant = "hero" | "compact";

export type ComposerProps = {
  variant?: Variant;
  placeholder?: string;
  engine?: EngineId;
  defaultEngine?: EngineId;
  pending?: boolean;
  autoFocus?: boolean;
  className?: string;
  /** Fused orchestrator header bar (HeyRico ref …_3). */
  orchestratorHeader?: boolean;
  /** Fused footer tray (e.g. the Upgrade-to-PRO strip on the hero). */
  tray?: React.ReactNode;
  /** Enable the "/" Choose-Agent slash command (default on hero). */
  enableAgentCommand?: boolean;
  /** Starting model for the picker (thread's current model on replies). */
  defaultModel?: string;
  onSubmit: (prompt: string, engine: EngineId, model: string) => void;
};

/**
 * The Skynet composer — a restyled prompt-kit `PromptInput`. Default `hero`
 * arrangement matches the HeyRico reference (heyrico-clean-design-2): a large
 * rounded card with "Ask anything…", a left cluster (+ · tools · Super Computer
 * chip · New) and a right cluster (✳ engine picker · mic · blue circular send).
 * Optional fused orchestrator header + footer tray, and a "/" Choose-Agent
 * slash command that renders the selection as a pink inline chip.
 *
 * The card surface/border swap via the AlignUI theme ladder; the blue send and
 * blue accents use the literal blue scale (which doesn't flip), so the anatomy
 * reads identically on the light card and the dark #20201f surface.
 */
export function Composer({
  variant = "hero",
  placeholder = "Ask anything...",
  engine: engineProp,
  defaultEngine = "opencode",
  pending = false,
  autoFocus = false,
  className,
  orchestratorHeader = false,
  tray,
  enableAgentCommand,
  defaultModel = "claude-opus-5",
  onSubmit,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [engineState, setEngineState] = useState<EngineId>(defaultEngine);
  const [model, setModel] = useState(defaultModel);
  const [command, setCommand] = useState<Agent | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);

  const engine = engineProp ?? engineState;
  const hero = variant === "hero";
  const allowAgent = enableAgentCommand ?? hero;
  const slashActive = allowAgent && !command && value.trimStart().startsWith("/");
  const showAgentPopover = slashActive || toolsOpen;
  const canSend = value.trim().length > 0 && !pending;

  function submit() {
    const text = value.trim();
    if (!text || pending) return;
    setValue("");
    onSubmit(text, engine, model);
  }

  function pickAgent(agent: Agent) {
    setCommand(agent);
    setValue("");
    setToolsOpen(false);
  }

  return (
    <div className={cn("relative w-full", className)}>
      {showAgentPopover && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-full">
          <ChooseAgentPopover query={slashActive ? value : ""} onSelect={pickAgent} />
        </div>
      )}

      {/* No overflow-hidden here: the engine-picker popover opens upward past the
          card edge and must not be clipped; header/tray round their own corners. */}
      <div className="border-stroke-soft-200 bg-bg-white-0 shadow-regular-md rounded-2xl border">
        {orchestratorHeader && (
          <div className="border-stroke-soft-200 bg-bg-weak-50 flex items-center gap-2 rounded-t-2xl border-b px-4 py-2.5">
            <span className="bg-static-black flex size-4 items-center justify-center rounded-full text-[10px] text-static-white">
              ◍
            </span>
            <span className="text-label-sm text-text-strong-950">Orchestrator</span>
            <span className="text-paragraph-sm text-text-soft-400">
              Routes each request
            </span>
          </div>
        )}

        <PromptInput
          value={value}
          onValueChange={setValue}
          onSubmit={submit}
          isLoading={pending}
          maxHeight={hero ? 220 : 150}
          className={cn(
            "cursor-text rounded-none border-0 bg-transparent shadow-none",
            hero ? "p-3 md:p-4" : "p-2.5",
          )}
        >
          <div className="flex items-start gap-1.5 px-1">
            {command && (
              <span className="pt-1">
                <AgentChip agent={command} onRemove={() => setCommand(null)} />
              </span>
            )}
            <PromptInputTextarea
              autoFocus={autoFocus}
              placeholder={command ? "" : placeholder}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && value === "" && command) {
                  setCommand(null);
                }
              }}
              className={cn(
                "flex-1",
                hero ? "pt-1 text-paragraph-lg" : "text-paragraph-sm",
              )}
            />
          </div>

          <div className="mt-1.5 flex items-center gap-1.5 px-0.5">
            {/* Left cluster */}
            <button
              type="button"
              aria-label="Add context"
              className="border-stroke-soft-200 text-text-sub-600 hover:bg-bg-weak-50 flex size-9 items-center justify-center rounded-xl border transition-colors"
            >
              <RiAddLine className="size-5" aria-hidden />
            </button>

            {hero && (
              <>
                <button
                  type="button"
                  aria-label="Tools & agents"
                  aria-expanded={toolsOpen}
                  onClick={() => setToolsOpen((o) => !o)}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-xl transition-colors",
                    toolsOpen
                      ? "bg-bg-weak-50 text-text-strong-950"
                      : "border-stroke-soft-200 text-text-sub-600 hover:bg-bg-weak-50 border",
                  )}
                >
                  <RiToolsLine className="size-[18px]" aria-hidden />
                </button>

                <span className="ml-1 flex items-center gap-1.5">
                  <RiSendPlane2Line className="text-text-sub-600 size-4" aria-hidden />
                  <span className="text-label-sm text-text-sub-600">Super Computer</span>
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-label-xs text-blue-500">
                    New
                  </span>
                </span>
              </>
            )}

            {/* Right cluster */}
            <div className="ml-auto flex items-center gap-1.5">
              {/* One engine now — the meaningful per-message choice is the MODEL. */}
              <ModelPicker model={model} onChange={setModel} />
              {hero && (
                <button
                  type="button"
                  aria-label="Voice input"
                  className="text-text-sub-600 hover:bg-bg-weak-50 flex size-9 items-center justify-center rounded-xl transition-colors"
                >
                  <RiMicLine className="size-5" aria-hidden />
                </button>
              )}
              <button
                type="button"
                aria-label="Send"
                onClick={submit}
                disabled={!canSend}
                className={cn(
                  "flex items-center justify-center rounded-full transition-all",
                  hero ? "size-10" : "size-9",
                  canSend
                    ? "bg-blue-500 text-white hover:bg-blue-600"
                    : "bg-bg-soft-200 text-text-soft-400 cursor-not-allowed",
                )}
              >
                {pending ? (
                  <Loader variant="circular" size="sm" className="border-white" />
                ) : (
                  <RiArrowUpLine className="size-5" aria-hidden />
                )}
              </button>
            </div>
          </div>
        </PromptInput>

        {tray && (
          <div className="border-stroke-soft-200 bg-bg-weak-50 rounded-b-2xl border-t">{tray}</div>
        )}
      </div>
    </div>
  );
}
