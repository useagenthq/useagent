import {
  conformanceEvidenceKey,
  conformanceRowPassed,
  mergeConformanceEvidenceRows,
  type ConformanceEvidenceRow,
} from "./evidence-cache";

export interface ConformanceEvidenceDocument {
  readonly provider: string;
  readonly results: readonly ConformanceEvidenceRow[];
  readonly snapshot: string;
}

export function combineConformanceEvidence(
  expectedKeys: readonly string[],
  documents: readonly ConformanceEvidenceDocument[],
): ConformanceEvidenceDocument & {
  readonly complete: true;
  readonly expectedTotal: number;
  readonly passed: number;
  readonly total: number;
} {
  const first = documents[0];
  if (!first) throw new Error("conformance evidence inputs are required");
  const replacements = new Map<string, ConformanceEvidenceRow>();
  for (const document of documents) {
    if (document.provider !== first.provider || document.snapshot !== first.snapshot) {
      throw new Error("conformance evidence provider or snapshot mismatch");
    }
    for (const row of document.results) {
      const key = conformanceEvidenceKey(row);
      if (replacements.has(key)) throw new Error(`duplicate conformance evidence ${key}`);
      replacements.set(key, row);
    }
  }
  const results = mergeConformanceEvidenceRows(expectedKeys, [], replacements);
  return {
    complete: true,
    expectedTotal: expectedKeys.length,
    passed: results.filter(conformanceRowPassed).length,
    provider: first.provider,
    results,
    snapshot: first.snapshot,
    total: results.length,
  };
}
