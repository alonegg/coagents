import { describe, expect, it } from "vitest";
import { endOfDayUtc, resolveDue } from "./planning.js";

describe("due dates", () => {
  it("reads a plain date as the end of that day in the project's zone", () => {
    expect(endOfDayUtc("2026-10-01", "Asia/Shanghai")).toBe("2026-10-01T15:59:59.999Z");
    expect(endOfDayUtc("2026-10-01", "UTC")).toBe("2026-10-01T23:59:59.999Z");
    expect(endOfDayUtc("2026-07-01", "America/Los_Angeles")).toBe("2026-07-02T06:59:59.999Z");
    // Across a DST change (US fall back on 2026-11-01).
    expect(endOfDayUtc("2026-11-01", "America/New_York")).toBe("2026-11-02T04:59:59.999Z");
  });

  it("keeps full timestamps as instants", () => {
    expect(resolveDue("2026-10-01T10:00:00+08:00", "UTC")).toBe("2026-10-01T02:00:00.000Z");
    expect(resolveDue(null, "UTC")).toBeNull();
  });
});
