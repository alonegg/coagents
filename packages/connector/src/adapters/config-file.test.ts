import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeFormat } from "./claude-code.js";
import { applyInstall, planInstall, removeInstall } from "./config-file.js";

const entry = { name: "coagents", command: "/usr/bin/node", args: ["/opt/coagents/main.js", "mcp"] };

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "coagents-cfg-"));
  return { path: join(root, ".mcp.json"), home: join(root, "home") };
}

describe("config file install and removal", () => {
  it("creates the file when absent and deletes it on uninstall", () => {
    const { path, home } = dirs();
    applyInstall(claudeCodeFormat, planInstall(claudeCodeFormat, path, entry), home);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.coagents.command).toBe("/usr/bin/node");
    expect(removeInstall(claudeCodeFormat, path, entry, home)).toBe("restored");
    expect(existsSync(path)).toBe(false);
  });

  it("restores an existing file byte for byte, including its formatting", () => {
    const { path, home } = dirs();
    const original = '{\n    "mcpServers": {"other": {"command": "x"}},\n    "zeta": 1, "alpha": [1,2]\n}';
    writeFileSync(path, original);
    const plan = planInstall(claudeCodeFormat, path, entry);
    applyInstall(claudeCodeFormat, plan, home);
    const installed = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(installed)).toEqual(["mcpServers", "zeta", "alpha"]);
    expect(Object.keys(installed.mcpServers)).toEqual(["other", "coagents"]);
    // Re-installing is a no-op and does not lose the original bytes.
    expect(planInstall(claudeCodeFormat, path, entry).after).toBeNull();
    expect(removeInstall(claudeCodeFormat, path, entry, home)).toBe("restored");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("keeps later edits and removes only its own entry", () => {
    const { path, home } = dirs();
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    applyInstall(claudeCodeFormat, planInstall(claudeCodeFormat, path, entry), home);
    const edited = JSON.parse(readFileSync(path, "utf8"));
    edited.mcpServers.mine = { command: "y" };
    writeFileSync(path, JSON.stringify(edited));
    expect(removeInstall(claudeCodeFormat, path, entry, home)).toBe("entry_removed");
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).mcpServers)).toEqual(["other", "mine"]);
  });
});

describe("diffLines", () => {
  it("aligns unchanged lines and shows removals before additions", async () => {
    const { diffLines } = await import("./config-file.js");
    expect(diffLines("a\nb\nc", "a\nB\nc\nd")).toBe("  a\n- b\n+ B\n  c\n+ d");
    expect(diffLines(null, "x")).toBe("+ x");
  });
});
