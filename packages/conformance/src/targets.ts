export interface ConformanceTarget {
  readonly caseId: string;
  readonly engine: string;
}

export function parseConformanceTargets(
  value: string,
  allowed: {
    readonly caseIds: ReadonlySet<string>;
    readonly engines: ReadonlySet<string>;
  },
): readonly ConformanceTarget[] {
  const observed = new Set<string>();
  return value.split(",").map((entry) => {
    const [engine, caseId, extra] = entry.split(":");
    if (
      extra !== undefined ||
      !engine ||
      !caseId ||
      !allowed.engines.has(engine) ||
      !allowed.caseIds.has(caseId)
    ) {
      throw new Error(`unsupported conformance target: ${entry}`);
    }
    const key = `${engine}:${caseId}`;
    if (observed.has(key)) throw new Error(`duplicate conformance target: ${key}`);
    observed.add(key);
    return { engine, caseId };
  });
}
