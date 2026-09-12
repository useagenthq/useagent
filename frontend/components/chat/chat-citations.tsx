// The sources a chat reply drew on. The chat engine's retrieval layer stores
// what it recalled on the run's done step (code_json.citations, one
// {title, source} per wiki, knowledge or memory hit); this reads them back
// and draws the compact "Sources" strip that closes the reply. Titles arrive
// as stored (a wiki title can carry HTML entities), so they are decoded for
// display, duplicates collapse, and the strip shows six chips plus a count.

import { Chip } from "@/components/base/badges/chip";
import { type ApiStep, asRecord, parseStepCode } from "@/components/chat/types";
import { decodeEntities } from "@/components/shared/plain-text-preview";

export type ChatCitationSource = "knowledge" | "wiki" | "memory";

export interface ChatCitation {
  readonly title: string;
  readonly source: ChatCitationSource;
}

const SOURCES = new Set<string>(["knowledge", "wiki", "memory"] satisfies ChatCitationSource[]);
const MAX_CHIPS = 6;

function isSource(value: unknown): value is ChatCitationSource {
  return typeof value === "string" && SOURCES.has(value);
}

/** The distinct citations stored on a turn's done step, display-ready and in
 *  stored order. Empty for turns without any (other engines, failed runs). */
export function chatCitationsFromSteps(steps: readonly ApiStep[]): ChatCitation[] {
  const done = steps.find((step) => step.kind === "done");
  const stored = done ? asRecord(parseStepCode(done))?.citations : null;
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const citations: ChatCitation[] = [];
  for (const item of stored) {
    const record = asRecord(item);
    const source = record?.source;
    const title = typeof record?.title === "string" ? decodeEntities(record.title).trim() : "";
    if (!title || !isSource(source)) continue;
    const key = `${source}:${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ title, source });
  }
  return citations;
}

/** The "Sources" strip under a chat reply: one chip per citation naming the
 *  title and where it came from, six at most, the rest as a count. Renders
 *  nothing when the turn cited nothing. */
export function ChatSourcesRow({ citations }: { citations: readonly ChatCitation[] }) {
  if (citations.length === 0) return null;
  const shown = citations.slice(0, MAX_CHIPS);
  const more = citations.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="chat-sources">
      <span className="text-caption-1-medium text-text-tertiary">Sources</span>
      {shown.map((citation) => (
        <Chip
          key={`${citation.source}:${citation.title}`}
          title={citation.title}
          data-testid="chat-source"
          color="soft"
          className="max-w-72 gap-1.5 rounded-full px-2 py-px"
        >
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
            {citation.source}
          </span>
          <span className="min-w-0 truncate">{citation.title}</span>
        </Chip>
      ))}
      {more > 0 && <span className="text-caption-1-medium text-text-tertiary">+{more} more</span>}
    </div>
  );
}
