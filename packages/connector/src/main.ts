#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { applyInstall, diffLines, planInstall, removeInstall, type ConfigFormat, type McpEntry } from "./adapters/config-file.js";
import { claudeCodeConfigPath, claudeCodeFormat } from "./adapters/claude-code.js";
import { codexConfigPath, codexFormat } from "./adapters/codex.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { findProjectBinding } from "./binding.js";
import { login } from "./login.js";
import { ServiceClient } from "./service.js";
import { EventStream } from "./sse.js";
import { createConnectorServer, type ConnectorState } from "./server.js";
import { coagentsHome, deleteCredential, forgetClientLeases, loadCredential, pruneHome } from "./store.js";
import { rmdirSync, rmSync } from "node:fs";

const USAGE = `coagents — CoAgents Connector

  coagents login --server <https://hub> --project <id> [--label <name>] [--read-only] [--dir <path>]
  coagents install claude-code [--dir <path>] [--yes]
  coagents uninstall claude-code [--dir <path>] [--keep-credential]
  coagents install codex [--yes]           (writes ~/.codex/config.toml)
  coagents uninstall codex
  coagents status [--dir <path>]
  coagents tool <name> [json-args] [--dir <path>]   Call one MCP tool and print the result
  coagents mcp            Run the stdio MCP server (what the client launches)`;

const ADAPTERS: Record<string, { format: ConfigFormat; path: (dir: string) => string }> = {
  "claude-code": { format: claudeCodeFormat, path: claudeCodeConfigPath },
  codex: { format: codexFormat, path: () => codexConfigPath() },
};

const say = (line: string) => process.stderr.write(`${line}\n`);

// The client launches this exact node binary and entry file, so installs work without a global package.
function ourEntry(): McpEntry {
  return { name: "coagents", command: process.execPath, args: [resolve(dirname(fileURLToPath(import.meta.url)), "main.js"), "mcp"] };
}

function state(dir: string): ConnectorState {
  const b = findProjectBinding(dir);
  if (!b.ok) {
    return {
      ok: false,
      message: b.reason === "not_found" ? "No .coagents/project.json in this directory or its parents; run `coagents login` here." : `Invalid ${b.path}: ${b.message}`,
    };
  }
  const home = coagentsHome();
  const credential = loadCredential(home, b.binding.server, b.binding.project_id);
  if (!credential) return { ok: false, message: `No credential for project ${b.binding.project_id} on this device; run \`coagents login\`.` };
  // Git checks run in the bound project's root: the directory that holds .coagents/.
  return { ok: true, credential, home, workdir: dirname(dirname(b.path)) };
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      project: { type: "string" },
      label: { type: "string" },
      "read-only": { type: "boolean" },
      dir: { type: "string" },
      yes: { type: "boolean" },
      "keep-credential": { type: "boolean" },
    },
  });
  const dir = resolve(values.dir ?? process.cwd());

  switch (command) {
    case "mcp": {
      const s = state(dir);
      if (s.ok) {
        // Keep a live event stream while the client runs, so the server records delivery to this device.
        // Delivered is not read: the agent still reads and acknowledges through get_context / ack_events.
        let detail: string | undefined;
        const svc = new ServiceClient(s.credential.server, s.credential.agent_token);
        const start = await svc.call<{ last_seen_seq: number }>("GET", `/projects/${s.credential.project_id}/cursor`).catch(() => ({ last_seen_seq: 0 }));
        const stream = new EventStream({
          url: (c) => `${s.credential.server}/v1/projects/${s.credential.project_id}/stream?cursor=${c}`,
          headers: { authorization: `Bearer ${s.credential.agent_token}`, "user-agent": "coagents-connector/0.1" },
          cursor: start.last_seen_seq,
          onEvent: () => {},
          onState: (st, d) => {
            detail = d;
            if (st === "revoked") say(`coagents: live stream ended: access revoked (${d ?? ""})`);
          },
        });
        void stream.run();
        s.stream = () => ({ state: stream.state, last_delivered_seq: stream.cursor, ...(detail ? { detail } : {}) });
      }
      await createConnectorServer(s).connect(new StdioServerTransport());
      return;
    }
    case "login": {
      if (!values.server || !values.project) throw new Error("login needs --server and --project");
      await login({
        server: values.server,
        projectId: values.project,
        label: values.label ?? `Connector on ${process.env.HOSTNAME ?? process.platform}`,
        scopes: values["read-only"] ? ["read"] : ["read", "write"],
        dir,
        home: coagentsHome(),
        say,
      });
      return;
    }
    case "install":
    case "uninstall": {
      const adapter = ADAPTERS[positionals[0] ?? ""];
      if (!adapter) throw new Error(`Unknown client "${positionals[0] ?? ""}". Supported: ${Object.keys(ADAPTERS).join(", ")}`);
      const path = adapter.path(dir);
      if (command === "install") {
        const plan = planInstall(adapter.format, path, ourEntry());
        if (plan.after === null) {
          say(`${path} already has the coagents entry; nothing to change.`);
          return;
        }
        say(`${plan.before === null ? "Create" : "Update"} ${path}:`);
        say(diffLines(plan.before, plan.after));
        if (!values.yes && !(await confirm("Write this change?"))) {
          say("Not changed. Re-run with --yes to write without asking.");
          process.exitCode = 1;
          return;
        }
        applyInstall(adapter.format, plan, coagentsHome());
        say(`Wrote ${path}. Restart the client in this directory and approve the "coagents" MCP server if it asks.`);
        return;
      }
      const outcome = removeInstall(adapter.format, path, ourEntry(), coagentsHome());
      say(
        outcome === "restored"
          ? `Restored ${path} to its state before install.`
          : outcome === "entry_removed"
            ? `${path} changed since install; removed only the coagents entry and kept your edits.`
            : `No coagents entry found in ${path}.`,
      );
      const s = state(dir);
      if (s.ok && !values["keep-credential"]) {
        await new ServiceClient(s.credential.server, s.credential.agent_token).call("DELETE", "/agent/me").catch((e: Error) => say(`Could not revoke on the server: ${e.message}`));
        deleteCredential(s.home, s.credential.server, s.credential.project_id);
        forgetClientLeases(s.home, s.credential.client_id);
        say(`Revoked and deleted the agent credential ${s.credential.client_id}.`);
        // The directory binding names this project only; remove it (and an empty .coagents/).
        const b = findProjectBinding(dir);
        if (b.ok && b.binding.project_id === s.credential.project_id) {
          rmSync(b.path, { force: true });
          try {
            rmdirSync(dirname(b.path));
          } catch {
            // other files live there
          }
          say(`Removed ${b.path}.`);
        }
      }
      pruneHome(coagentsHome());
      return;
    }
    case "tool": {
      const [name, json] = positionals;
      if (!name) throw new Error("tool needs a tool name");
      const [a, b] = InMemoryTransport.createLinkedPair();
      await createConnectorServer(state(dir)).connect(b);
      const client = new Client({ name: "coagents-cli", version: "0.1.0" });
      await client.connect(a);
      const res = (await client.callTool({ name, arguments: json ? (JSON.parse(json) as Record<string, unknown>) : {} })) as { isError?: boolean; content: { text: string }[] };
      process.stdout.write(`${res.content[0]?.text ?? ""}\n`);
      await client.close();
      process.exitCode = res.isError ? 1 : 0;
      return;
    }
    case "status": {
      const s = state(dir);
      if (!s.ok) {
        say(s.message);
        process.exitCode = 1;
        return;
      }
      const me = await new ServiceClient(s.credential.server, s.credential.agent_token).call<Record<string, unknown>>("GET", "/agent/me");
      process.stdout.write(`${JSON.stringify({ server: s.credential.server, ...me }, null, 2)}\n`);
      return;
    }
    default:
      say(USAGE);
      process.exitCode = command ? 2 : 0;
  }
}

main().catch((err: unknown) => {
  say(`coagents: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
