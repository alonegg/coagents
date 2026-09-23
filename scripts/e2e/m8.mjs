// M8 acceptance: cards, cross-project activity, archive/restore and delete as seen from machine B.
//   prepare (A): two projects shared with B's contributor, one private to A
//   b (B): cards and activity cover only shared projects; then follows A's archive/restore/delete
//   a (A): archives, restores and deletes, signalling through events
import assert from "node:assert/strict";
import { HubClient, env, step } from "./client.mjs";

const HUB = env("COAGENTS_HUB");
const rid = (p) => `m8-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(label, u, p) {
  const c = new HubClient(HUB, label);
  await c.login(env(u), env(p));
  return c;
}

async function prepare() {
  const o = await login("owner-A", "E2E_OWNER_USER", "E2E_OWNER_PASSWORD");
  const stamp = new Date().toISOString();
  const keep = await o.expect(201, "POST", "/projects", { name: `M8 归档恢复 ${stamp}`, description: "" });
  const gone = await o.expect(201, "POST", "/projects", { name: `M8 将删除 ${stamp}`, description: "" });
  const priv = await o.expect(201, "POST", "/projects", { name: `M8 私有 ${stamp}`, description: "" });
  await o.expect(201, "POST", `/projects/${priv.id}/tasks`, { title: "私有任务不应外泄", request_id: rid("p") });
  const tokens = [];
  for (const p of [keep, gone]) {
    await o.expect(201, "POST", `/projects/${p.id}/tasks`, { title: "共享任务", request_id: rid("t") });
    tokens.push((await o.expect(201, "POST", `/projects/${p.id}/invitations`, { role: "contributor", target_username: env("E2E_CONTRIB_USER") })).token);
  }
  console.log(JSON.stringify({ keep: keep.id, gone: gone.id, priv: priv.id, tokens }));
}

async function b() {
  const { keep, gone, priv, tokens } = JSON.parse(env("E2E_PAYLOAD"));
  const c = await login("contrib-B", "E2E_CONTRIB_USER", "E2E_CONTRIB_PASSWORD");
  for (const t of tokens) await c.call("POST", `/invitations/${t}/accept`);
  const cards = (await c.expect(200, "GET", `/projects?q=${encodeURIComponent("M8 ")}`)).projects;
  const ids = cards.map((p) => p.id);
  assert.ok(ids.includes(keep) && ids.includes(gone) && !ids.includes(priv));
  assert.equal(cards.find((p) => p.id === keep).summary.task_counts.todo, 1);
  const feed = (await c.expect(200, "GET", "/activity?limit=200")).events;
  assert.equal(feed.some((e) => e.project_id === priv || e.summary.includes("私有任务")), false);
  step("B: cards and cross-project activity include the two shared projects and nothing of A's private one");
  await c.expect(201, "POST", `/projects/${keep}/decisions`, { body: "[m8] B ready", request_id: rid("r") });

  let archived = null;
  for (let i = 0; i < 120 && !archived; i++) {
    const r = await c.call("POST", `/projects/${keep}/tasks`, { title: "归档后写入", request_id: rid("w") });
    if (r.status === 409 && r.body.error.code === "project_archived") archived = r;
    else await sleep(1000);
  }
  assert.ok(archived, "writes never became read-only");
  assert.equal((await c.expect(200, "GET", `/projects/${keep}/tasks`)).tasks.length >= 1, true);
  assert.equal((await c.expect(200, "GET", "/projects")).projects.some((p) => p.id === keep), false);
  assert.equal((await c.expect(200, "GET", "/projects?lifecycle=archived")).projects.some((p) => p.id === keep), true);
  step("B: after A archived, writes fail with project_archived, reads work, the project moved to the archived filter");

  let restored = false;
  for (let i = 0; i < 120 && !restored; i++) {
    const r = await c.call("POST", `/projects/${keep}/tasks`, { title: "恢复后写入", request_id: rid("w2") });
    restored = r.status === 201;
    if (!restored) await sleep(1000);
  }
  assert.ok(restored);
  step("B: after A restored, writing works again");

  let deleted = false;
  for (let i = 0; i < 120 && !deleted; i++) {
    deleted = (await c.call("GET", `/projects/${gone}`)).status === 404;
    if (!deleted) await sleep(1000);
  }
  assert.ok(deleted);
  assert.equal((await c.expect(200, "GET", "/projects")).projects.some((p) => p.id === gone), false);
  assert.equal((await c.expect(200, "GET", "/activity?limit=200")).events.some((e) => e.project_id === gone), false);
  step("B: after A deleted the other project, it is gone from direct URL, cards and activity");
}

async function a() {
  const { keep, gone } = JSON.parse(env("E2E_PAYLOAD"));
  const o = await login("owner-A", "E2E_OWNER_USER", "E2E_OWNER_PASSWORD");
  for (let i = 0; i < 300; i++) {
    const { events } = await o.expect(200, "GET", `/projects/${keep}/events?limit=200`);
    if (events.some((e) => e.data?.body === "[m8] B ready")) break;
    await sleep(1000);
  }
  await o.expect(200, "POST", `/projects/${keep}/archive`);
  step("A: archived");
  await sleep(8000);
  await o.expect(200, "POST", `/projects/${keep}/restore`);
  step("A: restored");
  await sleep(8000);
  await o.expect(204, "DELETE", `/projects/${gone}`);
  step("A: deleted the second project");
  const audit = (await o.expect(200, "GET", `/projects/${keep}/audit`)).records.map((r) => r.action);
  assert.ok(audit.includes("project.archive") && audit.includes("project.restore"));
  step("A: audit shows archive and restore");
}

const phases = { prepare, a, b };
if (!phases[process.argv[2]]) process.exit(2);
await phases[process.argv[2]]();
