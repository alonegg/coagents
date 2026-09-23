import { join } from "node:path";
import type { ConfigFormat, McpEntry } from "./config-file.js";

// Claude Code reads project-scoped MCP servers from .mcp.json at the project root:
// {"mcpServers": {"<name>": {"type": "stdio", "command": "...", "args": [...]}}}
export const claudeCodeFormat: ConfigFormat = {
  client: "claude-code",
  add(before, entry) {
    const doc = before === null ? {} : (JSON.parse(before) as Record<string, unknown>);
    const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
    const ours = { type: "stdio", command: entry.command, args: entry.args };
    if (JSON.stringify(servers[entry.name]) === JSON.stringify(ours)) return null;
    doc.mcpServers = { ...servers, [entry.name]: ours };
    return `${JSON.stringify(doc, null, 2)}\n`;
  },
  remove(current, entry) {
    const doc = JSON.parse(current) as { mcpServers?: Record<string, unknown> };
    if (!doc.mcpServers || !(entry.name in doc.mcpServers)) return null;
    delete doc.mcpServers[entry.name];
    return `${JSON.stringify(doc, null, 2)}\n`;
  },
};

export function claudeCodeConfigPath(projectDir: string): string {
  return join(projectDir, ".mcp.json");
}
