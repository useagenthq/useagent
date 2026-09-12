export type ConformanceEvidenceRow = Record<string, unknown>;

export function conformanceEvidenceKey(row: ConformanceEvidenceRow): string {
  if (typeof row.caseId !== "string" || typeof row.engine !== "string") {
    throw new Error("conformance evidence row is missing caseId or engine");
  }
  return `${row.engine}:${row.caseId}`;
}

export function conformanceRowPassed(row: ConformanceEvidenceRow): boolean {
  return row.passed === true && Array.isArray(row.errors) && row.errors.length === 0;
}

export function validateConformanceEvidenceRows(
  expectedKeys: readonly string[],
  rows: readonly ConformanceEvidenceRow[],
): void {
  const expected = new Set(expectedKeys);
  const observed = new Set<string>();
  for (const row of rows) {
    const key = conformanceEvidenceKey(row);
    if (!expected.has(key)) throw new Error(`conformance evidence contains unknown target ${key}`);
    if (observed.has(key)) throw new Error(`conformance evidence contains duplicate ${key}`);
    observed.add(key);
  }
}

export function planConformanceEvidenceReuse(
  expectedKeys: readonly string[],
  rows: readonly ConformanceEvidenceRow[],
): {
  readonly total: number;
  readonly reused: number;
  readonly refresh: readonly { readonly caseId: string; readonly engine: string }[];
} {
  validateConformanceEvidenceRows(expectedKeys, rows);
  const observed = new Map(rows.map((row) => [conformanceEvidenceKey(row), row]));
  const refresh = expectedKeys
    .filter((key) => !conformanceRowPassed(observed.get(key) ?? {}))
    .map((key) => {
      const separator = key.indexOf(":");
      return { engine: key.slice(0, separator), caseId: key.slice(separator + 1) };
    });
  return { total: expectedKeys.length, reused: expectedKeys.length - refresh.length, refresh };
}

export function mergeConformanceEvidenceRows(
  expectedKeys: readonly string[],
  rows: readonly ConformanceEvidenceRow[],
  replacements: ReadonlyMap<string, ConformanceEvidenceRow>,
): ConformanceEvidenceRow[] {
  const merged = applyConformanceEvidenceRows(expectedKeys, rows, replacements);
  if (merged.length !== expectedKeys.length) {
    const observed = new Set(merged.map(conformanceEvidenceKey));
    const missing = expectedKeys.find((key) => !observed.has(key));
    throw new Error(`missing refreshed evidence ${missing ?? "unknown"}`);
  }
  return merged;
}

export function applyConformanceEvidenceRows(
  expectedKeys: readonly string[],
  rows: readonly ConformanceEvidenceRow[],
  replacements: ReadonlyMap<string, ConformanceEvidenceRow>,
): ConformanceEvidenceRow[] {
  const plan = planConformanceEvidenceReuse(expectedKeys, rows);
  const planned = new Set(plan.refresh.map(({ engine, caseId }) => `${engine}:${caseId}`));
  for (const key of replacements.keys()) {
    if (!planned.has(key)) throw new Error(`unexpected refreshed evidence ${key}`);
  }
  const observed = new Map(rows.map((row) => [conformanceEvidenceKey(row), row]));
  return expectedKeys.flatMap((key) => {
    const row = replacements.get(key) ?? observed.get(key);
    return row ? [row] : [];
  });
}
