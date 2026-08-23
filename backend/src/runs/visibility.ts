import { isNull, notInArray, or } from "drizzle-orm";

import { runs } from "../db/schema";
import { INTERNAL_RUN_ORIGINS } from "./origin";

/** Product-facing run lists and aggregates exclude server-owned probes. */
export function publicRunCondition() {
  return or(
    isNull(runs.origin),
    notInArray(runs.origin, [...INTERNAL_RUN_ORIGINS]),
  )!;
}
