// M6 acceptance, machine B: take over a code handoff prepared on machine A (Codex CLI) through the
// Connector in this checkout. The checkout lacks the handed-over commit at first: acceptance must be
// refused with a reason and leave the working copy untouched; after `git fetch` it must succeed.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { HubClient, env, step } from "./client.mjs";

const HUB = env("COAGENTS_HUB");
const CLI = ["packages/connector/dist/main.js"];
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

function tool(name, args) {
  try {
    return { ok: true, value: JSON.parse(execFileSync("node", [...CLI, "tool", name, JSON.stringify(args)], { encoding: "utf8" })) };
  } catch (err) {
    return { ok: false, value: JSON.parse(err.stdout) };
  }
}

async function login(projectId, person) {
  const child = spawn("node", [...CLI, "login", "--server", HUB, "--project", projectId, "--label", "Connector on GitHub runner (machine B)"], { stdio: ["ignore", "inherit", "pipe"] });
  let err = "";
  const approved = new Promise((resolve, reject) => {
    child.stderr.on("data", async (d) => {
      err += d;
      const m = /([A-Z]{4}-[A-Z]{4})/.exec(err);
      if (m && !approved.started) {
        approved.started = true;
        // The person approves on this same machine, in their own Hub session.
        await person.expect(201, "POST", `/device-codes/${m[1]}/approve`).then(resolve, reject);
      }
    });
  });
  await approved;
  await new Promise((resolve, reject) => child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err)))));
}

async function b() {
  const { project_id, handoff_id, branch, commit } = JSON.parse(env("E2E_PAYLOAD"));
  const person = new HubClient(HUB, "contrib-B");
  await person.login(env("E2E_CONTRIB_USER"), env("E2E_CONTRIB_PASSWORD"));
  await login(project_id, person);
  step("B: Connector authorized for this checkout by device code");

  const head = git("rev-parse", "HEAD");
  assert.throws(() => git("cat-file", "-e", `${commit}^{commit}`));
  const refused = tool("accept_handoff", { handoff_id });
  assert.equal(refused.ok, false);
  assert.equal(refused.value.error.code, "handoff_check_failed");
  assert.match(refused.value.error.message, new RegExp(`fetch ${branch.replace(/[/]/g, "\\/")}`));
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("status", "--porcelain", "--", ".", ":(exclude).coagents"), "");
  step(`B: refused while ${commit.slice(0, 10)} is missing ("${refused.value.error.message.slice(0, 90)}…"); HEAD and working tree unchanged`);

  git("fetch", "-q", "origin", `${branch}:refs/remotes/origin/${branch}`);
  const ok = tool("accept_handoff", { handoff_id });
  assert.equal(ok.ok, true, JSON.stringify(ok.value));
  assert.equal(ok.value.handoff.state, "accepted");
  assert.equal(ok.value.local_check.has_commit, true);
  assert.equal(git("rev-parse", "HEAD"), head);
  step("B: after fetching the branch, the check passes and the task is taken over with a new lease; still nothing checked out");

  const sub = tool("submit_task", { task_id: ok.value.handoff.task_id, summary: "已在接收端确认 trials/HANDOFF_TRIAL.md 所在 commit", evidence: `git cat-file 确认 ${commit} 存在于本机工作副本` });
  assert.equal(sub.value.task.status, "review");
  step("B: submitted for review");
}

async function verify() {
  const { project_id, handoff_id } = JSON.parse(env("E2E_PAYLOAD"));
  const o = new HubClient(HUB, "owner-A");
  await o.login(env("E2E_OWNER_USER"), env("E2E_OWNER_PASSWORD"));
  const h = await o.expect(200, "GET", `/projects/${project_id}/handoffs/${handoff_id}`);
  assert.equal(h.state, "accepted");
  const t = await o.expect(200, "GET", `/projects/${project_id}/tasks/${h.task_id}`);
  assert.equal(t.status, "review");
  const { events } = await o.expect(200, "GET", `/projects/${project_id}/events?limit=200`);
  const kinds = events.map((e) => `${e.kind}${e.actor.client_id ? "(agent)" : ""}`);
  step(`A: handoff accepted, task in review; events: ${kinds.join(", ")}`);
  const { agents } = await o.expect(200, "GET", `/projects/${project_id}/agents`);
  step(`A: agent connections now: ${agents.map((a) => `${a.label} [${a.username}]`).join("; ")}`);
}

const phases = { b, verify };
if (!phases[process.argv[2]]) {
  console.error("usage: node scripts/e2e/m6.mjs b|verify");
  process.exit(2);
}
await phases[process.argv[2]]();
