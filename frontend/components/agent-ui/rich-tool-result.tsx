import {
  RiArrowDownSLine,
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiLoader4Line,
  RiToolsLine,
} from "@remixicon/react";
import { CodeBlock } from "@/components/ai/code-block";
import type { CanonicalEventLike } from "@/components/chat/canonical-timeline";

export interface RichToolResultProps {
  readonly event: Pick<
    CanonicalEventLike,
    "toolCallId" | "name" | "preview" | "status" | "durationMs" | "result" | "error" | "server"
  >;
  readonly resultLanguage?: string;
  readonly openByDefault?: boolean;
  readonly className?: string;
}

type ToolTone = "running" | "success" | "error";

function toolTone(event: RichToolResultProps["event"]): ToolTone {
  if (event.error || event.status === "error" || event.status === "failed") return "error";
  if (event.result !== undefined || event.status === "ok" || event.status === "completed") {
    return "success";
  }
  return "running";
}

const TONE_LABEL: Record<ToolTone, string> = {
  running: "Running",
  success: "Completed",
  error: "Failed",
};

function ToneIcon({ tone }: { readonly tone: ToolTone }) {
  if (tone === "success") {
    return <RiCheckboxCircleFill className="size-4 text-success-base" aria-hidden />;
  }
  if (tone === "error") {
    return <RiCloseCircleFill className="size-4 text-error-base" aria-hidden />;
  }
  return <RiLoader4Line className="size-4 animate-spin text-information-base" aria-hidden />;
}

export function RichToolResult({
  event,
  resultLanguage = "plaintext",
  openByDefault = false,
  className,
}: RichToolResultProps) {
  const tone = toolTone(event);
  const hasDetails = Boolean(event.result || event.error || event.preview);

  return (
    <details
      open={openByDefault}
      className={`group overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs ${className ?? ""}`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-base">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-bg-weak-50">
          <RiToolsLine className="size-4 text-text-sub-600" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label-sm text-text-strong-950">
            {event.name ?? "Tool result"}
          </span>
          <span className="flex flex-wrap gap-x-2 text-paragraph-xs text-text-soft-400">
            {event.server && <span>{event.server}</span>}
            {typeof event.durationMs === "number" && (
              <span className="font-mono tabular-nums">{event.durationMs} ms</span>
            )}
            {event.toolCallId && <span className="font-mono">{event.toolCallId}</span>}
          </span>
        </span>
        <span role="status" className="flex shrink-0 items-center gap-1.5 text-label-xs">
          <ToneIcon tone={tone} />
          <span className={tone === "error" ? "text-error-base" : "text-text-sub-600"}>
            {TONE_LABEL[tone]}
          </span>
        </span>
        {hasDetails && (
          <RiArrowDownSLine
            className="size-4 shrink-0 text-text-soft-400 transition-transform group-open:rotate-180"
            aria-hidden
          />
        )}
      </summary>
      {hasDetails && (
        <div className="space-y-3 border-t border-stroke-soft-200 bg-bg-weak-50 p-3">
          {event.preview && <p className="text-paragraph-sm text-text-sub-600">{event.preview}</p>}
          {event.error ? (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-error-lighter p-3 font-mono text-paragraph-xs text-error-base">
              {event.error}
            </pre>
          ) : event.result ? (
            <CodeBlock code={event.result} language={resultLanguage} />
          ) : null}
        </div>
      )}
    </details>
  );
}
