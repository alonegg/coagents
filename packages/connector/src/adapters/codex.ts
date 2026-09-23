import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigFormat, McpEntry } from "./config-file.js";

// Codex reads MCP servers from ~/.codex/config.toml (or $CODEX_HOME/config.toml). It starts stdio
// servers in the session's working directory, so one global entry serves every bound project.
// We only ever add or remove our own marked table; the rest of the file is left byte for byte.
const MARK = "# Added by CoAgents (`coagents install codex`); remove with `coagents uninstall codex`.";

function block(entry: McpEntry): string {
  return `${MARK}\n[mcp_servers.${entry.name}]\ncommand = ${JSON.stringify(entry.command)}\nargs = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]\n`;
}

// Finds our table: from the marker (or header) up to the next table that is not one of its subtables.
function locate(text: string, name: string): { start: number; end: number } | null {
  const lines = text.split("\n");
  const header = lines.findIndex((l) => l.trim() === `[mcp_servers.${name}]`);
  if (header < 0) return null;
  const start = header > 0 && lines[header - 1] === MARK ? header - 1 : header;
  let end = header + 1;
  while (end < lines.length && !(/^\s*\[/.test(lines[end]!) && !lines[end]!.trim().startsWith(`[mcp_servers.${name}.`))) end++;
  while (end > header + 1 && lines[end - 1]!.trim() === "") end--;
  return { start, end };
}

export const codexFormat: ConfigFormat = {
  client: "codex",
  add(before, entry) {
    const text = before ?? "";
    const ours = block(entry);
    const at = locate(text, entry.name);
    if (at) {
      const lines = text.split("\n");
      const existing = `${lines.slice(at.start, at.end).join("\n")}\n`;
      if (existing === ours) return null;
      return [...lines.slice(0, at.start), ...ours.trimEnd().split("\n"), ...lines.slice(at.end)].join("\n");
    }
    const sep = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${sep}${ours}`;
  },
  remove(current, entry) {
    const at = locate(current, entry.name);
    if (!at) return null;
    const lines = current.split("\n");
    // Also drop the blank separator line we put before the table.
    const start = at.start > 0 && lines[at.start - 1] === "" ? at.start - 1 : at.start;
    let end = at.end;
    while (end < lines.length - 1 && lines[end] === "" && start < at.start) end++;
    const out = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
    return out.endsWith("\n") || out === "" ? out : `${out}\n`;
  },
};

export function codexConfigPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
}
