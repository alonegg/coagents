import { describe, expect, it } from "vitest";
import { PublishBlockerInput, ReleaseTaskInput, TaskStatus, nextStatus } from "./tasks.js";

describe("task state machine", () => {
  it("allows only the documented transitions", () => {
    const table = TaskStatus.options.map((s) => [s, nextStatus("claim", s)]);
    expect(table).toEqual([
      ["todo", "in_progress"],
      ["in_progress", null],
      ["blocked", "in_progress"],
      ["review", null],
      ["done", null],
    ]);
    expect(nextStatus("submit", "in_progress")).toBe("review");
    expect(nextStatus("accept", "in_progress")).toBeNull();
    expect(nextStatus("reopen", "done")).toBe("todo");
  });
});

describe("task inputs", () => {
  it("requires a lease token to release", () => {
    expect(ReleaseTaskInput.safeParse({ task_id: "t1", request_id: "req-00001" }).success).toBe(false);
  });

  it("requires task_id and lease_token together on blockers", () => {
    const base = { body: "missing data", request_id: "req-00001" };
    expect(PublishBlockerInput.safeParse(base).success).toBe(true);
    expect(PublishBlockerInput.safeParse({ ...base, task_id: "t1" }).success).toBe(false);
    expect(
      PublishBlockerInput.safeParse({ ...base, task_id: "t1", lease_token: "x".repeat(32) }).success,
    ).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(ReleaseTaskInput.safeParse({ task_id: "t1", lease_token: "x".repeat(32), request_id: "req-00001", status: "done" }).success).toBe(false);
  });
});
