import { isNull } from "drizzle-orm";

import { runs } from "../db/schema";

/** Product-facing run lists expose only user-created traffic. Internal origins
 * are server-owned and intentionally open-ended, so an old or newly added
 * probe origin must never become visible merely because a static allowlist
 * forgot its name. */
export function publicRunCondition() {
  return isNull(runs.origin);
}
