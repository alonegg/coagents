// M5 acceptance: artifacts across two machines.
//   prepare (A, owner): project, invitations for contributor and viewer, a restricted budget file, a task
//   b (B): viewer cannot see the restricted file anywhere (list, events, detail, direct URL);
//          contributor downloads it, imports a document with provenance, publishes it, submits the task with it
//   verify (A): owner sees the submission bound to that version, accepts; a later version does not change the binding
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HubClient, env, step } from "./client.mjs";

const HUB = env("COAGENTS_HUB");
const [, , phase] = process.argv;
const rid = (p) => `m5-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const BUDGET = "# 2026 预算\n\n机密：仅限指定成员。\n";

async function upload(c, pid, filename, bytes) {
  const res = await fetch(`${HUB}/v1/projects/${pid}/files`, {
    method: "POST",
    headers: { "x-csrf-token": c.csrf, "x-filename": encodeURIComponent(filename), cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    body: bytes,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}

async function download(c, path) {
  const res = await fetch(`${HUB}/v1${path}`, { headers: { cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

async function owner() {
  const o = new HubClient(HUB, "owner-A");
  await o.login(env("E2E_OWNER_USER"), env("E2E_OWNER_PASSWORD"));
  return o;
}

async function prepare() {
  const o = await owner();
  const p = await o.expect(201, "POST", "/projects", { name: `M5 成果 ${new Date().toISOString()}`, description: "" });
  const invC = await o.expect(201, "POST", `/projects/${p.id}/invitations`, { role: "contributor", target_username: env("E2E_CONTRIB_USER"), expires_in_hours: 2 });
  const invV = await o.expect(201, "POST", `/projects/${p.id}/invitations`, { role: "viewer", target_username: env("E2E_VIEWER_USER"), expires_in_hours: 2 });
  const task = await o.expect(201, "POST", `/projects/${p.id}/tasks`, { title: "整理历史调研报告", acceptance_criteria: "导入并发布报告，注明原作者与日期", request_id: rid("task") });
  console.log(JSON.stringify({ project_id: p.id, contrib_token: invC.token, viewer_token: invV.token, task_id: task.id }));
}

// Owner restricts the budget to the contributor once both have joined (called from verify-setup).
async function restrict() {
  const { project_id: pid } = JSON.parse(env("E2E_PAYLOAD"));
  const o = await owner();
  // Check membership before creating anything, so a retry never leaves an unrestricted copy behind.
  const { members } = await o.expect(200, "GET", `/projects/${pid}/members`);
  const contrib = members.find((m) => m.username === env("E2E_CONTRIB_USER"));
  if (!contrib) {
    console.error("contributor has not joined yet");
    process.exit(3);
  }
  const f = await upload(o, pid, "预算.md", Buffer.from(BUDGET));
  const a = await o.expect(201, "POST", `/projects/${pid}/artifacts`, { title: "2026 预算", kind: "file", file_id: f.id, request_id: rid("budget") });
  const pub = await o.expect(200, "POST", `/projects/${pid}/artifacts/${a.id}/publish`, { expected_revision: 1, request_id: rid("pub") });
  await o.expect(200, "PUT", `/projects/${pid}/artifacts/${a.id}/access`, { visibility: "restricted", user_ids: [contrib.user_id], request_id: rid("acl") });
  console.log(JSON.stringify({ budget_id: a.id, budget_version: pub.versions[0].id }));
}

async function b() {
  const { project_id: pid, contrib_token, viewer_token, task_id } = JSON.parse(env("E2E_PAYLOAD"));
  const c = new HubClient(HUB, "contrib-B");
  await c.login(env("E2E_CONTRIB_USER"), env("E2E_CONTRIB_PASSWORD"));
  await c.call("POST", `/invitations/${contrib_token}/accept`);
  const v = new HubClient(HUB, "viewer-B");
  await v.login(env("E2E_VIEWER_USER"), env("E2E_VIEWER_PASSWORD"));
  await v.call("POST", `/invitations/${viewer_token}/accept`);
  await c.expect(200, "GET", `/projects/${pid}`);
  await v.expect(200, "GET", `/projects/${pid}`);
  await c.expect(201, "POST", `/projects/${pid}/decisions`, { body: "[m5] B joined", request_id: rid("joined") });
  step("B: contributor and viewer joined");

  // Wait for A to publish and restrict the budget.
  let budget;
  for (let i = 0; i < 120 && !budget; i++) {
    budget = (await c.expect(200, "GET", `/projects/${pid}/artifacts`)).artifacts.find((a) => a.title === "2026 预算" && a.visibility === "restricted");
    if (!budget) await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(budget, "restricted budget never appeared for the contributor");
  const detail = await c.expect(200, "GET", `/projects/${pid}/artifacts/${budget.id}`);
  const fileUrl = `/projects/${pid}/artifacts/${budget.id}/versions/${detail.versions[0].id}/file`;
  const got = await download(c, fileUrl);
  assert.equal(got.status, 200);
  assert.equal(sha(got.bytes), sha(Buffer.from(BUDGET)));
  step("B: contributor on the restricted list downloads the budget intact");

  const vList = (await v.expect(200, "GET", `/projects/${pid}/artifacts`)).artifacts;
  assert.equal(vList.some((a) => a.id === budget.id), false);
  const vEvents = (await v.expect(200, "GET", `/projects/${pid}/events?limit=200`)).events;
  assert.equal(vEvents.some((e) => e.subject_id === budget.id), false);
  const vAll = await v.expect(200, "GET", `/projects/${pid}/artifacts`);
  assert.equal(JSON.stringify(vAll).includes(budget.id), false);
  assert.equal((await v.call("GET", `/projects/${pid}/artifacts/${budget.id}`)).status, 404);
  const direct = await download(v, fileUrl);
  assert.equal(direct.status, 404);
  assert.equal(direct.bytes.includes(Buffer.from("机密")), false);
  step("B: viewer sees no trace of it in list, events or detail, and the direct file URL returns 404");

  // Import an existing report with provenance, publish, and submit the task with it.
  const report = Buffer.from("旧调研报告：结论是采用 SQLite。\n");
  const up = await upload(c, pid, "调研报告.txt", report);
  const art = await c.expect(201, "POST", `/projects/${pid}/artifacts`, {
    title: "历史调研报告",
    kind: "file",
    file_id: up.id,
    task_id,
    source_author: "张老师",
    source_at: "2025-03-01",
    request_id: rid("import"),
  });
  assert.equal((await v.call("GET", `/projects/${pid}/artifacts/${art.id}`)).status, 404);
  const pub = await c.expect(200, "POST", `/projects/${pid}/artifacts/${art.id}/publish`, { expected_revision: 1, request_id: rid("pub") });
  const vv = await v.expect(200, "GET", `/projects/${pid}/artifacts/${art.id}`);
  assert.equal(vv.source_author, "张老师");
  const vd = await download(v, `/projects/${pid}/artifacts/${art.id}/versions/${vv.versions[0].id}/file?inline=1`);
  assert.equal(sha(vd.bytes), sha(report));
  assert.equal(vd.headers.get("content-type"), "text/plain; charset=utf-8");
  step("B: imported report stays private as a draft, then the viewer reads it after publication with provenance");

  assert.equal((await v.call("POST", `/projects/${pid}/artifacts`, { title: "x", kind: "link", url: "https://example.org", request_id: rid("v") })).status, 403);
  step("B: viewer cannot create artifacts");

  await c.expect(200, "POST", `/projects/${pid}/tasks/${task_id}/claim`, { request_id: rid("claim") });
  const sub = await c.expect(200, "POST", `/projects/${pid}/tasks/${task_id}/submit`, { summary: "已导入并发布调研报告", artifact_version_ids: [pub.versions[0].id], request_id: rid("submit") });
  assert.equal(sub.task.status, "review");
  const counts = (await v.expect(200, "GET", `/projects/${pid}/tasks`)).tasks.filter((t) => t.status === "done").length;
  assert.equal(counts, 0);
  step("B: task submitted with the published version; publishing did not complete anything");
  console.log(`RESULT ${JSON.stringify({ artifact_id: art.id, version_id: pub.versions[0].id })}`);
}

async function verify() {
  const { project_id: pid, task_id } = JSON.parse(env("E2E_PAYLOAD"));
  const o = await owner();
  const t = await o.expect(200, "GET", `/projects/${pid}/tasks/${task_id}`);
  const s = t.submissions[0];
  assert.equal(s.artifacts[0].title, "历史调研报告");
  assert.equal(s.artifacts[0].version, 1);
  const art = await o.expect(200, "GET", `/projects/${pid}/artifacts/${s.artifacts[0].artifact_id}`);
  assert.equal(art.imported_by, art.author.id);
  assert.equal(art.source_at, "2025-03-01");
  const accepted = await o.expect(200, "POST", `/projects/${pid}/tasks/${task_id}/accept`, { expected_version: t.version, note: "报告已核对", request_id: rid("accept") });
  assert.equal(accepted.status, "done");
  step("A: owner sees the submission bound to 历史调研报告 v1 with provenance, and accepts it");

  await o.expect(200, "PATCH", `/projects/${pid}/artifacts/${art.id}/draft`, { expected_revision: 0, title: "历史调研报告（修订）", request_id: rid("d") });
  await o.expect(200, "POST", `/projects/${pid}/artifacts/${art.id}/publish`, { expected_revision: 1, request_id: rid("p") });
  const after = (await o.expect(200, "GET", `/projects/${pid}/tasks/${task_id}`)).submissions[0];
  assert.equal(after.artifacts[0].version, 1);
  assert.equal(after.outcome, "accepted");
  step("A: after v2 is published the accepted submission still points to v1");
}

const phases = { prepare, restrict, b, verify };
if (!phases[phase]) {
  console.error("usage: node scripts/e2e/m5.mjs prepare|restrict|b|verify");
  process.exit(2);
}
await phases[phase]();
