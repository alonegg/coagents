import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexFormat } from "./codex.js";
import { applyInstall, planInstall, removeInstall } from "./config-file.js";

const entry = { name: "coagents", command: "/usr/bin/node", args: ["/opt/中文/main.js", "mcp"] };
const EXISTING = `model = "gpt-6-sol"

[mcp_servers.node_repl]
command = "node"

[mcp_servers.node_repl.env]
A = "1"

[projects."/tmp/x"]
trust_level = "trusted"
`;

describe("codex config", () => {
  it("removes the config directory again when the install created it", () => {
    const root = mkdtempSync(join(tmpdir(), "coagents-codex-"));
    const path = join(root, "fresh", ".codex", "config.toml");
    applyInstall(codexFormat, planInstall(codexFormat, path, entry), join(root, "home"));
    expect(removeInstall(codexFormat, path, entry, join(root, "home"))).toBe("restored");
    expect(existsSync(join(root, "fresh", ".codex"))).toBe(false);
  });

  it("appends a marked table and restores the original bytes on uninstall", () => {
    const root = mkdtempSync(join(tmpdir(), "coagents-codex-"));
    const path = join(root, "config.toml");
    writeFileSync(path, EXISTING);
    applyInstall(codexFormat, planInstall(codexFormat, path, entry), join(root, "home"));
    const text = readFileSync(path, "utf8");
    expect(text.startsWith(EXISTING)).toBe(true);
    expect(text).toContain('[mcp_servers.coagents]\ncommand = "/usr/bin/node"\nargs = ["/opt/中文/main.js", "mcp"]');
    expect(planInstall(codexFormat, path, entry).after).toBeNull();
    expect(removeInstall(codexFormat, path, entry, join(root, "home"))).toBe("restored");
    expect(readFileSync(path, "utf8")).toBe(EXISTING);
  });

  it("leaves no trace when removing after other edits elsewhere in the file", () => {
    const edited = codexFormat.add(EXISTING, entry)!.replace('model = "gpt-6-sol"', 'model = "gpt-5.5"');
    expect(codexFormat.remove(edited, entry)).toBe(EXISTING.replace('model = "gpt-6-sol"', 'model = "gpt-5.5"'));
  });

  it("removes only its own table (and subtables) when the file changed since install", () => {
    const withOurs = codexFormat.add(EXISTING, entry)!;
    const edited = `${withOurs.replace('command = "node"', 'command = "node20"')}\n[mcp_servers.coagents.env]\nX = "1"\n\n[later]\nk = 1\n`;
    const out = codexFormat.remove(edited, entry)!;
    expect(out).not.toContain("coagents");
    expect(out).toContain('command = "node20"');
    expect(out).toContain("[later]\nk = 1");
    expect(out).toContain('[projects."/tmp/x"]');
  });
});
