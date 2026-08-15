import { describe, expect, test } from "bun:test";
import { cadenceLabel, scheduleZone } from "@/app/agent/schedules/schedules-data";

describe("automation presentation", () => {
  test("explains supported cadence patterns without hiding cron semantics", () => {
    expect(cadenceLabel("0 9 * * 1-5")).toBe("Weekdays at 9:00 AM");
    expect(cadenceLabel("30 14 * * *")).toBe("Every day at 2:30 PM");
    expect(cadenceLabel("0 7 * * 1")).toBe("Every Monday at 7:00 AM");
    expect(cadenceLabel("*/15 * * * *")).toBe("Every 15 minutes");
    expect(cadenceLabel("5 4 1 * *")).toBe("5 4 1 * *");
  });

  test("labels explicit and server timezones honestly", () => {
    expect(scheduleZone({ timezone: "Asia/Kolkata" })).toBe("Asia/Kolkata");
    expect(scheduleZone({ timezone: null })).toBe("Server timezone");
  });
});
