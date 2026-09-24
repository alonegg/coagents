import { describe, expect, it } from "vitest";
import { assignCriterionIds, compareVersions, criteriaCoverage, EvidenceItem } from "./protocol.js";

describe("acceptance checklist", () => {
  it("keeps ids, numbers new items after the highest ever used, rejects unknown ids", () => {
    const first = assignCriterionIds([], [{ text: "a" }, { text: "b" }], 1);
    expect(first).toEqual({ criteria: [{ id: "c1", text: "a" }, { id: "c2", text: "b" }], next: 3 });
    const edited = assignCriterionIds([{ id: "c1", text: "a" }, { id: "c2", text: "b" }], [{ id: "c2", text: "b2" }, { text: "c" }], 3);
    expect(edited).toEqual({ criteria: [{ id: "c2", text: "b2" }, { id: "c3", text: "c" }], next: 4 });
    expect(assignCriterionIds([{ id: "c2", text: "b" }], [{ id: "c1", text: "x" }], 4)).toEqual({ error: "Unknown criterion id c1" });
    expect(assignCriterionIds([{ id: "c2", text: "b" }], [{ id: "c2", text: "x" }, { id: "c2", text: "y" }], 4)).toEqual({ error: "Duplicate criterion id c2" });
  });

  it("derives coverage per criterion", () => {
    const criteria = ["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => ({ id, text: id }));
    const cov = criteriaCoverage(criteria, [
      { criterion_id: "c1", kind: "test", ref: "t", result: "pass" },
      { criterion_id: "c2", kind: "test", ref: "t", result: "pass" },
      { criterion_id: "c2", kind: "review", result: "fail", detail: "d" },
      { criterion_id: "c3", kind: "commit", ref: "a".repeat(40) },
      { criterion_id: "c4", kind: "note", result: "not_applicable", detail: "n/a" },
      { criterion_id: "c5", kind: "review", result: "partial", detail: "d" },
    ]);
    expect(cov.map((c) => c.status)).toEqual(["pass", "fail", "unverified", "not_applicable", "partial", "missing"]);
  });
});

describe("evidence items", () => {
  it("requires the ref and result each kind needs", () => {
    expect(EvidenceItem.safeParse({ kind: "test", ref: "pnpm test" }).success).toBe(false);
    expect(EvidenceItem.safeParse({ kind: "test", ref: "pnpm test", result: "pass" }).success).toBe(true);
    expect(EvidenceItem.safeParse({ kind: "commit", ref: "HEAD" }).success).toBe(false);
    expect(EvidenceItem.safeParse({ kind: "link", ref: "javascript:alert(1)" }).success).toBe(false);
    expect(EvidenceItem.safeParse({ kind: "link", ref: "https://ci.example/run/1" }).success).toBe(true);
    expect(EvidenceItem.safeParse({ kind: "note", detail: "x", extra: 1 }).success).toBe(false);
  });
});

it("compares versions numerically", () => {
  expect(compareVersions("0.10.0", "0.9.1")).toBe(1);
  expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
  expect(compareVersions("0.1.9", "0.2.0")).toBe(-1);
});
