import { downloadTextFile } from "@/lib/download-file";
import { buildTimelineFromCanonical, shouldUseCanonicalTimeline } from "./canonical-timeline";
import type { Turn } from "./conversation";
import type { ThreadSnapshot } from "./thread-store";
import { buildTimeline, hasNarration, type TimelineNode } from "./timeline";
import { clip, summarizeToolStep, toolStepNames } from "./tool-summary";
import { splitTurn, turnNodesFromSteps } from "./turn-trace-model";
import { asRecord, cleanPrompt, parseStepCode } from "./types";

export interface ThreadExportData {
  readonly threadId: string;
  readonly turns: readonly Turn[];
  readonly snapshot: ThreadSnapshot;
}

export type ThreadExportFormat = "markdown" | "json";

function inlineCode(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const longest = Math.max(0, ...(line.match(/`+/g) ?? []).map((match) => match.length));
  const fence = "`".repeat(longest + 1);
  return `${fence} ${line} ${fence}`;
}

function linkLabel(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[\\`*_[\]<>]/g, "\\$&");
}

function artifactHref(id: string, origin: string): string {
  return new URL(`/api/artifacts/${encodeURIComponent(id)}/content?download=1`, origin).href;
}

function turnTimeline(turn: Turn, canonicalTimeline: boolean): TimelineNode[] | null {
  if (turn.canonical && shouldUseCanonicalTimeline(canonicalTimeline, turn)) {
    return buildTimelineFromCanonical(
      turn.canonical,
      new Map(turn.steps.map((step) => [step.id, step])),
      turn.live,
    );
  }
  return turn.native ? buildTimeline(turn.native, turn.live) : null;
}

/** Format the loaded conversation using the same authoritative lane as the UI.
 * This runs only when exporting, never for each streamed event. */
export function formatThreadMarkdown(
  { threadId, turns }: Pick<ThreadExportData, "threadId" | "turns">,
  origin: string,
  canonicalTimeline = false,
): string {
  const blocks = [`# Thread ${inlineCode(threadId)}`];
  if (turns.some((turn) => turn.pendingOutline)) {
    blocks.push(
      "> This export includes loaded history only. Some earlier turns have not been loaded.",
    );
  }

  for (const [index, turn] of turns.entries()) {
    blocks.push(`## Turn ${index + 1}`);
    if (turn.pendingOutline) {
      blocks.push("> This turn's messages and steps have not been loaded.");
      continue;
    }
    blocks.push("### User", cleanPrompt(turn.run.prompt));

    const timeline = turnTimeline(turn, canonicalTimeline);
    const nodes = timeline ?? turnNodesFromSteps(turn.steps, turn.live, turn.status);
    const messages = nodes.filter((node) => node.kind === "text").map((node) => node.text);
    // A terminal narration burst already owns the answer. The durable summary
    // is the fallback when the timeline ends in work, as on the thread page.
    if ((!timeline || !splitTurn(timeline, turn.live).reply) && turn.summary) {
      messages.push(turn.summary);
    } else if (turn.live && !turn.summary && !hasNarration(nodes) && turn.liveText) {
      messages.push(turn.liveText);
    }
    if (messages.length > 0) blocks.push("### Assistant", ...messages);
    if (turn.live) blocks.push("> This turn is still in progress.");

    const steps = nodes
      .filter((node) => node.kind === "tool")
      .map(({ step }) => {
        const summary = summarizeToolStep(step);
        const tool = toolStepNames(step)[0] ?? summary.verb;
        const input = asRecord(asRecord(parseStepCode(step))?.input);
        const args = asRecord(input?.arguments) ?? input;
        // UI chips shorten paths to basenames. An exported target keeps the path
        // so similarly named files in different directories stay distinguishable.
        const target = [
          summary.command,
          args?.file_path,
          args?.filePath,
          args?.path,
          args?.filename,
          summary.object,
        ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
        return `- ${inlineCode(tool)}${target ? `: ${inlineCode(clip(target, 160))}` : ""}`;
      });
    if (steps.length > 0) blocks.push("### Steps", steps.join("\n"));

    const files: string[] = [];
    for (const node of nodes) {
      if (node.kind === "artifact") {
        files.push(
          `- [${linkLabel(node.artifact.name)}](<${artifactHref(node.artifact.id, origin)}>)`,
        );
      } else if (node.kind === "file") {
        const diff = node.file.diff
          ? ` ([diff](<${artifactHref(node.file.diff.artifactId, origin)}>))`
          : "";
        files.push(`- ${node.file.changeType}: ${inlineCode(node.file.path)}${diff}`);
      }
    }
    if (files.length > 0) blocks.push("### Files", files.join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

/** Keep the page's wire objects intact rather than replacing them with the
 * human-readable Markdown projection. Explicit arrays avoid serializing Maps. */
export function formatThreadJson({ threadId, turns, snapshot }: ThreadExportData): string {
  return `${JSON.stringify(
    {
      threadId,
      unloadedRunIds: turns.filter((turn) => turn.pendingOutline).map((turn) => turn.run.id),
      runs: snapshot.runs,
      events: snapshot.runs.map((run) => {
        const view = snapshot.byId.get(run.id);
        return {
          runId: run.id,
          steps: view?.native.steps ?? run.steps,
          nativeFrames: view?.native.nativeFrames ?? [],
          canonicalEvents: view?.canonical ?? [],
          canonicalComplete: view?.canonicalComplete ?? false,
          canonicalDegraded: view?.canonicalDegraded ?? false,
          liveText: view?.liveText ?? "",
          liveReasoning: view?.liveReasoning ?? "",
        };
      }),
    },
    null,
    2,
  )}\n`;
}

export function downloadThreadExport(
  content: string,
  threadId: string,
  format: ThreadExportFormat,
): void {
  const extension = format === "markdown" ? "md" : "json";
  const type =
    format === "markdown" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8";
  downloadTextFile(content, `thread-${threadId}.${extension}`, type);
}
