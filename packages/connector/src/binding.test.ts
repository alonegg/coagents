import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findProjectBinding } from "./binding.js";

function makeTree(): { root: string; nested: string } {
  const root = mkdtempSync(join(tmpdir(), "coagents-bind-"));
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  return { root, nested };
}

function bind(dir: string, content: string): void {
  mkdirSync(join(dir, ".coagents"), { recursive: true });
  writeFileSync(join(dir, ".coagents", "project.json"), content);
}

describe("findProjectBinding", () => {
  it("finds the nearest binding walking up", () => {
    const { root, nested } = makeTree();
    bind(root, JSON.stringify({ server: "https://hub.example.test", project_id: "p1" }));
    const res = findProjectBinding(nested);
    expect(res).toMatchObject({ ok: true, binding: { project_id: "p1" } });
  });

  it("does not fall back to a parent when the nearest binding is invalid", () => {
    const { root, nested } = makeTree();
    bind(root, JSON.stringify({ server: "https://hub.example.test", project_id: "p1" }));
    bind(join(root, "a"), JSON.stringify({ server: "https://hub.example.test", project_id: "p2", token: "secret" }));
    expect(findProjectBinding(nested)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("reports not_found when there is no binding", () => {
    const { nested } = makeTree();
    expect(findProjectBinding(nested)).toEqual({ ok: false, reason: "not_found" });
  });
});
