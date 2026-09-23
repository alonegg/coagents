// Clean-machine install/run/uninstall on a fresh GitHub runner: after uninstalling both client
// configurations nothing of CoAgents is left in the home directory, the project directory or the
// process list, and the server has revoked the credential.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HubClient, env, step } from "./client.mjs";

const HUB = env("COAGENTS_HUB");
const CLI = resolve("packages/connector/dist/main.js");
const home = homedir();

function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out[p.slice(dir.length)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

async function run() {
  const { project_id } = JSON.parse(env("E2E_PAYLOAD"));
  const project = mkdtempSync(join(tmpdir(), "coagents-clean-"));
  execFileSync("git", ["init", "-q", project]);
  const before = { project: tree(project), coagents: existsSync(join(home, ".coagents")), codex: existsSync(join(home, ".codex")) };
  assert.equal(before.coagents, false);
  step(`clean machine: no ~/.coagents, ~/.codex exists: ${before.codex}`);

  const person = new HubClient(HUB, "contrib-clean");
  await person.login(env("E2E_CONTRIB_USER"), env("E2E_CONTRIB_PASSWORD"));
  const child = spawn("node", [CLI, "login", "--server", HUB, "--project", project_id, "--label", "clean-machine check", "--dir", project], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  let approved = false;
  child.stderr.on("data", (d) => {
    err += d;
    const m = /([A-Z]{4}-[A-Z]{4})/.exec(err);
    if (m && !approved) {
      approved = true;
      void person.expect(201, "POST", `/device-codes/${m[1]}/approve`);
    }
  });
  await new Promise((res, rej) => child.on("exit", (c) => (c === 0 ? res() : rej(new Error(err)))));
  const cli = (...a) => execFileSync("node", [CLI, ...a], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  cli("install", "claude-code", "--yes", "--dir", project);
  cli("install", "codex", "--yes");
  assert.ok(existsSync(join(project, ".mcp.json")) && existsSync(join(home, ".codex", "config.toml")));
  const ctx = JSON.parse(cli("tool", "get_context", "{}", "--dir", project));
  assert.equal(ctx.project.id, project_id);
  const token = JSON.parse(readFileSync(join(home, ".coagents", "credentials.json"), "utf8"));
  const agentToken = Object.values(token)[0].agent_token;
  step("installed both client configurations and made a real tool call");

  cli("uninstall", "codex", "--keep-credential");
  cli("uninstall", "claude-code", "--dir", project);
  assert.deepEqual(tree(project), before.project);
  assert.equal(existsSync(join(home, ".coagents")), false);
  assert.equal(existsSync(join(home, ".codex")), before.codex);
  const procs = execFileSync("sh", ["-c", `pgrep -fl "${CLI}" || true`], { encoding: "utf8" }).trim();
  assert.equal(procs, "");
  const revoked = await fetch(`${HUB}/v1/agent/me`, { headers: { authorization: `Bearer ${agentToken}` } });
  assert.equal(revoked.status, 401);
  step("after uninstall: project directory byte-identical, no ~/.coagents, ~/.codex as before, no connector process, credential revoked (401)");
}

if (process.argv[2] === "run") await run();
