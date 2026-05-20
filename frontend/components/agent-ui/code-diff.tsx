import { CodeBlock, type CodeBlockProps } from "@/components/ai/code-block";
import { type DiffRow, DiffTable } from "@/components/ai/diff-table";

export interface CodeDiffProps {
  readonly title: string;
  readonly code: Pick<CodeBlockProps, "code" | "filename" | "language" | "streaming">;
  readonly changes: readonly DiffRow[];
  readonly className?: string;
}

/** A source snapshot and its structured change summary, using the vendored beUI ports. */
export function CodeDiff({ title, code, changes, className }: CodeDiffProps) {
  return (
    <section aria-label={title} className={className}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-label-sm text-text-strong-950">{title}</h3>
        <span className="font-mono text-label-xs text-text-soft-400">
          {changes.length} {changes.length === 1 ? "change" : "changes"}
        </span>
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.8fr)]">
        <CodeBlock {...code} />
        <DiffTable columns={["File", "Symbol", "Change"]} rows={[...changes]} />
      </div>
    </section>
  );
}

export type { DiffRow };
