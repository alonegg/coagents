// M7 acceptance across two machines and time zones.
//   prepare (A, project zone Asia/Shanghai): milestone due "2026-10-01" (a plain date), three tasks in
//     scope, a Chinese PDF (unique word on page 2), a project-visible note; invitations for B
//   b (B, viewer in America/Los_Angeles): same due instant and counts as A; finds the PDF by a body-only
//     word with page 2; sees the note, then after A restricts it, search returns nothing (total 0)
//   a (A): waits for B, restricts the note, finishes and descopes tasks, confirms the milestone
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HubClient, env, step } from "./client.mjs";

const HUB = env("COAGENTS_HUB");
const [, , phase] = process.argv;
const rid = (p) => `m7-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const fmt = (iso, tz) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(iso));
const say = (c, pid, body) => c.expect(201, "POST", `/projects/${pid}/decisions`, { body, request_id: rid("say") });
const bodyOf = (e) => (typeof e.data?.body === "string" ? e.data.body : "");
async function waitEvent(c, pid, text, ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const { events } = await c.expect(200, "GET", `/projects/${pid}/events?limit=200`);
    if (events.some((e) => bodyOf(e) === text)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timed out waiting for "${text}"`);
}

async function owner() {
  const o = new HubClient(HUB, "owner-A");
  await o.login(env("E2E_OWNER_USER"), env("E2E_OWNER_PASSWORD"));
  return o;
}

async function prepare() {
  const o = await owner();
  const p = await o.expect(201, "POST", "/projects", { name: `M7 里程碑与检索 ${new Date().toISOString()}`, description: "", timezone: "Asia/Shanghai" });
  const tasks = [];
  for (const t of ["评审材料", "接口联调", "发布说明"]) tasks.push((await o.expect(201, "POST", `/projects/${p.id}/tasks`, { title: t, request_id: rid("t") })).id);
  let m = await o.expect(201, "POST", `/projects/${p.id}/milestones`, { title: "十月演示", criteria: "三项工作完成并演示", due_at: "2026-10-01", request_id: rid("m") });
  m = await o.expect(200, "POST", `/projects/${p.id}/milestones/${m.id}/scope`, { expected_version: m.version, add_task_ids: tasks, reason: "演示范围", request_id: rid("s") });
  const pdfPath = env("E2E_PDF");
  const up = await fetch(`${HUB}/v1/projects/${p.id}/files`, {
    method: "POST",
    headers: { "x-csrf-token": o.csrf, "x-filename": encodeURIComponent("第三季度评审.pdf"), cookie: [...o.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    body: readFileSync(pdfPath),
  }).then((r) => r.json());
  const pdf = await o.expect(201, "POST", `/projects/${p.id}/artifacts`, { title: "第三季度评审", kind: "file", file_id: up.id, request_id: rid("pdf") });
  await o.expect(200, "POST", `/projects/${p.id}/artifacts/${pdf.id}/publish`, { expected_revision: 1, request_id: rid("pp") });
  const note = await o.expect(201, "POST", `/projects/${p.id}/artifacts`, { title: "供应商备忘", kind: "markdown", body: "候选供应商代号紫藤，报价待定。", request_id: rid("note") });
  await o.expect(200, "POST", `/projects/${p.id}/artifacts/${note.id}/publish`, { expected_revision: 1, request_id: rid("np") });
  const inv = await o.expect(201, "POST", `/projects/${p.id}/invitations`, { role: "viewer", target_username: env("E2E_VIEWER_USER"), expires_in_hours: 2 });
  console.log(JSON.stringify({ project_id: p.id, milestone_id: m.id, task_ids: tasks, note_id: note.id, viewer_token: inv.token, due_at: m.due_at }));
}

async function b() {
  const { project_id: pid, milestone_id, viewer_token, due_at } = JSON.parse(env("E2E_PAYLOAD"));
  const v = new HubClient(HUB, "viewer-B");
  await v.login(env("E2E_VIEWER_USER"), env("E2E_VIEWER_PASSWORD"));
  await v.call("POST", `/invitations/${viewer_token}/accept`);
  const me = await v.expect(200, "GET", "/session");

  const m = await v.expect(200, "GET", `/projects/${pid}/milestones/${milestone_id}`);
  assert.equal(m.due_at, due_at);
  const { tasks } = await v.expect(200, "GET", `/projects/${pid}/tasks`);
  assert.equal(m.counts.total, tasks.filter((t) => t.milestone_id === milestone_id).length);
  step(`B (${me.user.timezone}, runner TZ ${Intl.DateTimeFormat().resolvedOptions().timeZone}): milestone due ${due_at} = ${fmt(due_at, me.user.timezone)} here = ${fmt(due_at, "Asia/Shanghai")} in the project zone; counts match the board (${m.counts.total})`);

  let pdfHit;
  for (let i = 0; i < 30 && !pdfHit; i++) {
    pdfHit = (await v.expect(200, "GET", `/projects/${pid}/search?q=${encodeURIComponent("蓝鲸协议")}`)).hits[0];
    if (!pdfHit) await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(pdfHit, "PDF body word not found");
  assert.equal(pdfHit.title, "第三季度评审");
  assert.equal(pdfHit.location.page, 2);
  const used = await v.expect(200, "GET", `/projects/${pid}/search?q=${encodeURIComponent("沿用")}`);
  assert.equal(used.total, 1);
  step(`B: "蓝鲸协议" found only in the PDF body, page ${pdfHit.location.page}: ${pdfHit.snippet}; "沿用" matches too (compatibility ideographs normalized)`);

  const before = await v.expect(200, "GET", `/projects/${pid}/search?q=${encodeURIComponent("紫藤")}`);
  assert.equal(before.total, 1);
  await say(v, pid, "[m7] B saw note").catch(() => {});
  step("B: note visible and searchable before restriction");
  await waitEvent(v, pid, "[m7] note restricted").catch(async () => {
    // Viewers cannot post decisions; fall back to polling the search itself.
  });
  let after;
  for (let i = 0; i < 120; i++) {
    after = await v.expect(200, "GET", `/projects/${pid}/search?q=${encodeURIComponent("紫藤")}`);
    if (after.total === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.deepEqual({ total: after.total, hits: after.hits }, { total: 0, hits: [] });
  assert.equal(JSON.stringify(after).includes("紫藤"), false);
  step("B: after A restricted the note, search returns total 0 and no snippet");

  let achieved;
  for (let i = 0; i < 120 && !achieved; i++) {
    achieved = (await v.expect(200, "GET", `/projects/${pid}/events?limit=200`)).events.find((e) => e.kind === "milestone.achieved");
    if (!achieved) await new Promise((r) => setTimeout(r, 1000));
  }
  const final = await v.expect(200, "GET", `/projects/${pid}/milestones/${milestone_id}`);
  assert.equal(final.state, "achieved");
  const scope = (await v.expect(200, "GET", `/projects/${pid}/events?limit=200`)).events.filter((e) => e.kind === "milestone.scope_changed").map((e) => e.data.reason);
  step(`B: milestone achieved "${final.confirm_note}" with ${final.counts.done}/${final.counts.total} done; scope reasons visible: ${scope.join(" / ")}`);
}

async function a() {
  const { project_id: pid, milestone_id, task_ids, note_id } = JSON.parse(env("E2E_PAYLOAD"));
  const o = await owner();
  // Wait until B has searched the note once (B polls; give it time to join and look).
  for (let i = 0; i < 180; i++) {
    const { members } = await o.expect(200, "GET", `/projects/${pid}/members`);
    if (members.some((m) => m.username === env("E2E_VIEWER_USER"))) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 25_000));
  await o.expect(200, "PUT", `/projects/${pid}/artifacts/${note_id}/access`, { visibility: "restricted", user_ids: [], request_id: rid("acl") });
  await say(o, pid, "[m7] note restricted");
  step("A: restricted the note to owners/admins");

  for (const id of task_ids.slice(0, 2)) {
    await o.expect(200, "POST", `/projects/${pid}/tasks/${id}/claim`, { request_id: rid("c") });
    const s = await o.expect(200, "POST", `/projects/${pid}/tasks/${id}/submit`, { summary: "完成", evidence: "演示通过", request_id: rid("s") });
    await o.expect(200, "POST", `/projects/${pid}/tasks/${id}/accept`, { expected_version: s.task.version, request_id: rid("a") });
  }
  let m = await o.expect(200, "GET", `/projects/${pid}/milestones/${milestone_id}`);
  const blocked = await o.call("POST", `/projects/${pid}/milestones/${milestone_id}/achieve`, { expected_version: m.version, note: "演示通过", request_id: rid("x") });
  assert.equal(blocked.status, 409);
  step(`A: achievement refused while "发布说明" is unfinished: ${blocked.body.error.message.slice(0, 60)}…`);
  m = await o.expect(200, "POST", `/projects/${pid}/milestones/${milestone_id}/scope`, { expected_version: m.version, remove_task_ids: [task_ids[2]], reason: "发布说明延到下个里程碑", request_id: rid("r") });
  const done = await o.expect(200, "POST", `/projects/${pid}/milestones/${milestone_id}/achieve`, { expected_version: m.version, note: "十月演示已完成，录屏见成果", request_id: rid("ok") });
  assert.equal(done.state, "achieved");
  step("A: descoped with a reason and confirmed the milestone");
}

const phases = { prepare, a, b };
if (!phases[phase]) {
  console.error("usage: node scripts/e2e/m7.mjs prepare|a|b");
  process.exit(2);
}
await phases[phase]();
