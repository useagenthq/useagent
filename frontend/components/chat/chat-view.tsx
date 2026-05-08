"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  RiBookOpenLine,
  RiExternalLinkLine,
  RiRobot2Line,
} from "@remixicon/react";
import { backendFetch } from "@/lib/backend-fetch";
import { cnExt as cn } from "@/utils/cn";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import { Composer } from "@/components/chat/composer";
import { Loader } from "@/components/prompt-kit/loader";
import { Message, MessageContent } from "@/components/prompt-kit/message";
import type { MemoryScope } from "@/components/chat/types";

/** One retrieved source, mirrored from the backend `chat/retrieve.ts` contract. */
type Citation = {
  title: string;
  url?: string;
  source: "knowledge" | "wiki" | "memory";
};

type ChatMsg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  error?: string;
  streaming?: boolean;
};

/**
 * The lightweight Chat surface (#122) - a NO-SANDBOX conversational page. Talks to
 * the model directly through `/api/chat` (SSE), augmented with read-only retrieval
 * (org knowledge + wiki + team memory) shown as an honest "Sources" affordance, and
 * a "Promote to Agent" action that starts a real sandbox run from the conversation.
 *
 * Performance (AGENTS.md): streamed deltas are buffered and applied ONCE per
 * animation frame (apply-the-burst-paint-once), and message rows are memoized so a
 * flush only re-renders the streaming row.
 */
export function ChatView() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [promoting, setPromoting] = useState(false);

  // Mirror of `messages` for reading prior history / the promote transcript without
  // stale closures (the composer callbacks are created once).
  const messagesRef = useRef<ChatMsg[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Delta batching: collect tokens in a buffer and apply per animation frame.
  const bufferRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Stick-to-bottom while streaming, unless the user has scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const flush = useCallback(() => {
    rafRef.current = null;
    const chunk = bufferRef.current;
    if (!chunk) return;
    bufferRef.current = "";
    const id = activeIdRef.current;
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content: m.content + chunk } : m)),
    );
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(flush);
  }, [flush]);

  // Apply any buffered text immediately and clear the streaming flag on the row.
  const finalize = useCallback((assistantId: string) => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const chunk = bufferRef.current;
    bufferRef.current = "";
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId
          ? { ...m, content: m.content + chunk, streaming: false }
          : m,
      ),
    );
  }, []);

  const handleFrame = useCallback(
    (frame: string, assistantId: string) => {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) return; // `:` heartbeat / open comment
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (event === "delta") {
        const d = (parsed as { delta?: unknown }).delta;
        if (typeof d === "string") {
          bufferRef.current += d;
          scheduleFlush();
        }
      } else if (event === "context") {
        const cits = (parsed as { citations?: unknown }).citations;
        if (Array.isArray(cits)) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, citations: cits as Citation[] } : m,
            ),
          );
        }
      } else if (event === "error") {
        const e = (parsed as { error?: unknown }).error;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, error: typeof e === "string" ? e : "stream error", streaming: false }
              : m,
          ),
        );
      }
    },
    [scheduleFlush],
  );

  const consumeStream = useCallback(
    async (bodyStream: ReadableStream<Uint8Array>, assistantId: string) => {
      const reader = bodyStream.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf("\n\n");
          while (idx !== -1) {
            handleFrame(buf.slice(0, idx), assistantId);
            buf = buf.slice(idx + 2);
            idx = buf.indexOf("\n\n");
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
    [handleFrame],
  );

  const send = useCallback(
    async (
      prompt: string,
      _engine: string,
      _model: string,
      _key: string,
      memoryScope: MemoryScope,
    ) => {
      const history = messagesRef.current
        .filter((m) => m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));
      const userMsg: ChatMsg = {
        id: crypto.randomUUID(),
        role: "user",
        content: prompt,
        citations: [],
      };
      const assistantId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: "assistant", content: "", citations: [], streaming: true },
      ]);
      activeIdRef.current = assistantId;
      pinnedRef.current = true;
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await backendFetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [...history, { role: "user", content: prompt }],
            memoryScope,
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const detail = (await res.json().catch(() => ({}))) as { error?: unknown };
          throw new Error(
            typeof detail.error === "string" ? detail.error : `backend ${res.status}`,
          );
        }
        await consumeStream(res.body, assistantId);
        finalize(assistantId);
      } catch (err) {
        finalize(assistantId);
        // Aborting (Stop) is expected: the partial answer stays, no error banner.
        if (!controller.signal.aborted) {
          const message = err instanceof Error ? err.message : "could not reach the model";
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, error: message } : m)),
          );
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [consumeStream, finalize],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Cancel an in-flight stream if the page unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const hasConversation = messages.some((m) => m.role === "user");
  const canPromote = hasConversation && !streaming && !promoting;

  const promote = useCallback(async () => {
    const convo = messagesRef.current.filter((m) => m.content.trim());
    if (!convo.some((m) => m.role === "user")) return;
    setPromoting(true);
    try {
      const transcript = convo
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.trim()}`)
        .join("\n\n");
      const prompt =
        "Continue the following chat conversation as an agent with a sandbox. " +
        "Pick up the latest request and do the work.\n\n" +
        transcript;
      const res = await backendFetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, engine: "opencode", model: "claude-opus-5" }),
      });
      if (!res.ok) throw new Error(`backend ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { id?: unknown };
      if (typeof body.id !== "string") throw new Error("no run id");
      router.push(`/session/${body.id}`);
    } catch {
      // Stay on the page; the button re-enables so the user can retry.
      setPromoting(false);
    }
  }, [router]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-stroke-soft-200 bg-bg-white-0 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-mono-label text-text-soft-400">Chat</span>
          <span className="text-text-sub-600 truncate text-paragraph-xs">
            direct model, no sandbox
          </span>
        </div>
        <button
          type="button"
          onClick={promote}
          disabled={!canPromote}
          title="Start a real sandbox run from this conversation"
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-label-xs transition-colors",
            canPromote
              ? "border-stroke-soft-200 text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950"
              : "border-stroke-soft-200 text-text-disabled-300 cursor-not-allowed",
          )}
        >
          {promoting ? (
            <Loader variant="circular" size="sm" />
          ) : (
            <RiRobot2Line className="size-4" aria-hidden />
          )}
          Promote to Agent
        </button>
      </div>

      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
          <div className="flex max-w-md flex-col items-center gap-3 text-center">
            <span className="bg-primary-alpha-10 flex size-12 items-center justify-center rounded-2xl">
              <AsteriskMark className="text-primary-base size-6" />
            </span>
            <h1 className="text-title-h5 text-text-strong-950">What can I help with?</h1>
            <p className="text-text-sub-600 text-paragraph-sm">
              Chat directly with the model - instant and cheap. It can draw on your org
              knowledge, wiki, and team memory. Need real execution? Promote to an agent run.
            </p>
          </div>
          <div className="w-full max-w-2xl">
            <Composer
              variant="hero"
              surface="white"
              enableAgentCommand={false}
              enableModelPicker={false}
              placeholder="Ask anything..."
              autoFocus
              onSubmit={send}
              running={streaming}
              onStop={handleStop}
            />
          </div>
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
              {messages.map((m) => (
                <MessageRow key={m.id} msg={m} />
              ))}
            </div>
          </div>
          <div className="border-stroke-soft-200 bg-bg-white-0 shrink-0 border-t px-4 py-3">
            <div className="mx-auto max-w-3xl">
              <Composer
                variant="compact"
                surface="white"
                enableAgentCommand={false}
                enableModelPicker={false}
                placeholder="Reply..."
                onSubmit={send}
                running={streaming}
                onStop={handleStop}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const MessageRow = memo(function MessageRow({ msg }: { msg: ChatMsg }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-bg-weak-50 text-text-strong-950 max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-paragraph-sm">
          {msg.content}
        </div>
      </div>
    );
  }
  return (
    <Message className="items-start">
      <span className="bg-primary-alpha-10 flex size-8 shrink-0 items-center justify-center rounded-full">
        <AsteriskMark className="text-primary-base size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        {msg.content ? (
          <MessageContent markdown className="text-paragraph-sm">
            {msg.content}
          </MessageContent>
        ) : msg.streaming && !msg.error ? (
          <span className="text-text-soft-400 flex items-center gap-2 text-paragraph-sm">
            <Loader variant="typing" size="sm" />
            Thinking
          </span>
        ) : null}
        {msg.error && (
          <div role="alert" className="text-error-base text-paragraph-xs">
            {msg.error}
          </div>
        )}
        {msg.citations.length > 0 && <Sources citations={msg.citations} />}
      </div>
    </Message>
  );
});

function Sources({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="border-stroke-soft-200 bg-bg-weak-50 text-text-sub-600 hover:text-text-strong-950 inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-label-xs transition-colors"
      >
        <RiBookOpenLine className="size-3.5" aria-hidden />
        {citations.length} source{citations.length > 1 ? "s" : ""}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1">
          {citations.map((c) => (
            <li
              key={`${c.source}:${c.title}`}
              className="text-text-sub-600 flex items-start gap-1.5 text-paragraph-xs"
            >
              <span className="bg-bg-weak-50 text-text-soft-400 mt-0.5 rounded px-1 text-subheading-2xs uppercase">
                {c.source}
              </span>
              {c.url ? (
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-text-strong-950 inline-flex items-center gap-1 hover:underline"
                >
                  {c.title}
                  <RiExternalLinkLine className="size-3 shrink-0" aria-hidden />
                </a>
              ) : (
                <span className="text-text-strong-950">{c.title}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
