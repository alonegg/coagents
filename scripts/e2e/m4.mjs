// M4 acceptance across two machines, coordinated only through the project's own events.
//   prepare (A): project + targeted invitation for B
//   a (A): ping/pong latency, then 20 events while B is offline, then waits for B's checks
//   b (B): pong every ping, drop the stream and resume from its cursor, revoke one of its two devices
import assert from "node:assert/strict";
import { HubClient, cookieHeader, env, follow, step, waitFor } from "./client.mjs";

const HUB = env("COAGENTS_HUB");
const PINGS = 30;
const OFFLINE_EVENTS = 20;
const [, , phase] = process.argv;
const say = (c, pid, body) => c.expect(201, "POST", `/projects/${pid}/decisions`, { body, request_id: `m4-${Math.random().toString(36).slice(2)}-${Date.now()}` });
const bodyOf = (e) => (typeof e.data?.body === "string" ? e.data.body : "");

async function prepare() {
  const owner = new HubClient(HUB, "owner-A");
  await owner.login(env("E2E_OWNER_USER"), env("E2E_OWNER_PASSWORD"));
  const p = await owner.expect(201, "POST", "/projects", { name: `M4 实时与撤权 ${new Date().toISOString()}`, description: "" });
  const inv = await owner.expect(201, "POST", `/projects/${p.id}/invitations`, { role: "contributor", target_username: env("E2E_CONTRIB_USER"), expires_in_hours: 2 });
  console.log(JSON.stringify({ project_id: p.id, invite_token: inv.token }));
}

async function a() {
  const { project_id: pid } = JSON.parse(env("E2E_PAYLOAD"));
  const owner = new HubClient(HUB, "owner-A");
  await owner.login(env("E2E_OWNER_USER"), env("E2E_OWNER_PASSWORD"));
  const seen = [];
  const s = follow(`${HUB}/v1/projects/${pid}/stream`, cookieHeader(owner), { onEvent: (seq, e) => seen.push({ seq, e, at: Date.now() }) });
  const saw = (pred, ms, label) => waitFor(() => seen.find((x) => pred(bodyOf(x.e))), ms, label);

  await saw((b) => b === "[m4] B ready", 300_000, "B ready");
  step("A: B is online");
  const rtts = [];
  for (let i = 0; i < PINGS; i++) {
    const t0 = Date.now();
    await say(owner, pid, `[m4] ping ${i}`);
    const pong = await saw((b) => b === `[m4] pong ${i}`, 10_000, `pong ${i}`);
    rtts.push(pong.at - t0);
    await new Promise((r) => setTimeout(r, 200));
  }
  rtts.sort((x, y) => x - y);
  const p = (q) => rtts[Math.min(rtts.length - 1, Math.ceil(q * rtts.length) - 1)];
  step(`A: A→B→A round trip over ${PINGS} pings: p50 ${p(0.5)}ms, p95 ${p(0.95)}ms, max ${rtts[rtts.length - 1]}ms (one hop ≈ half, includes both writes)`);
  assert.ok(p(0.95) / 2 <= 2000, "one-hop p95 over 2s");

  await saw((b) => b === "[m4] B offline", 30_000, "B offline");
  for (let i = 0; i < OFFLINE_EVENTS; i++) await owner.expect(201, "POST", `/projects/${pid}/tasks`, { title: `离线期间任务 ${i}`, request_id: `m4-off-${pid}-${i}` });
  await say(owner, pid, "[m4] A done writing");
  step(`A: wrote ${OFFLINE_EVENTS} tasks while B's stream was down`);

  const resumed = await saw((b) => b.startsWith("[m4] B resumed"), 60_000, "B resumed");
  step(`A: B reports ${bodyOf(resumed.e)}`);
  const revoked = await saw((b) => b.startsWith("[m4] B revoke"), 60_000, "B revoke result");
  step(`A: B reports ${bodyOf(revoked.e)}`);
  s.stop();
  assert.ok(!bodyOf(resumed.e).includes("FAIL") && !bodyOf(revoked.e).includes("FAIL"));
}

async function b() {
  const { project_id: pid, invite_token } = JSON.parse(env("E2E_PAYLOAD"));
  const dev1 = new HubClient(HUB, "contrib-B-dev1");
  await dev1.login(env("E2E_CONTRIB_USER"), env("E2E_CONTRIB_PASSWORD"));
  const acc = await dev1.call("POST", `/invitations/${invite_token}/accept`);
  assert.ok([201, 404].includes(acc.status));

  // Stage 1: answer pings.
  let s1 = follow(`${HUB}/v1/projects/${pid}/stream`, cookieHeader(dev1), {
    onEvent: (_seq, e) => {
      const m = /^\[m4\] ping (\d+)$/.exec(bodyOf(e));
      if (m) void say(dev1, pid, `[m4] pong ${m[1]}`);
    },
  });
  await new Promise((r) => setTimeout(r, 1000));
  await say(dev1, pid, "[m4] B ready");
  await new Promise((r) => setTimeout(r, 1000));
  // Wait until A has finished pinging (last pong sent), by watching our own pongs via the list API.
  await waitFor(async () => false, 0, "noop").catch(() => {});
  for (;;) {
    const evs = (await dev1.expect(200, "GET", `/projects/${pid}/events?cursor=0&limit=200`)).events;
    if (evs.some((e) => bodyOf(e) === `[m4] pong ${PINGS - 1}`)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  step("B: answered all pings");

  // Stage 2: drop the stream, stay offline while A writes, resume from the last delivered cursor.
  const lastSeq = s1.cursor();
  s1.stop();
  await say(dev1, pid, "[m4] B offline");
  for (;;) {
    const evs = (await dev1.expect(200, "GET", `/projects/${pid}/events?cursor=${lastSeq}&limit=200`)).events;
    if (evs.some((e) => bodyOf(e) === "[m4] A done writing")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const got = [];
  const s2 = follow(`${HUB}/v1/projects/${pid}/stream?cursor=${lastSeq}`, cookieHeader(dev1), { onEvent: (seq, e) => got.push({ seq, e }) });
  await waitFor(() => got.find((x) => bodyOf(x.e) === "[m4] A done writing"), 30_000, "resume backlog");
  const truth = (await dev1.expect(200, "GET", `/projects/${pid}/events?cursor=${lastSeq}&limit=200`)).events.filter((e) => e.seq <= got[got.length - 1].seq);
  const gotSeqs = got.map((x) => x.seq);
  const ok = JSON.stringify(gotSeqs) === JSON.stringify(truth.map((e) => e.seq));
  const offlineTasks = got.filter((x) => x.e.kind === "task.created").length;
  step(`B: resumed from seq ${lastSeq}, received ${got.length} events in order, ${offlineTasks} offline tasks, matches server list: ${ok}`);
  await say(dev1, pid, `[m4] B resumed ${ok && offlineTasks === OFFLINE_EVENTS ? "OK" : "FAIL"}: ${got.length} events, ${offlineTasks} tasks, no gaps: ${ok}`);
  s2.stop();

  // Stage 3: two devices online; revoke one from the other; the revoked stream stops, the other continues.
  const dev2 = new HubClient(HUB, "contrib-B-dev2");
  await dev2.login(env("E2E_CONTRIB_USER"), env("E2E_CONTRIB_PASSWORD"));
  const d1 = [], d2 = [];
  let d2Revoked = false;
  const f1 = follow(`${HUB}/v1/projects/${pid}/stream`, cookieHeader(dev1), { onEvent: (seq, e) => d1.push(bodyOf(e)) });
  const f2 = follow(`${HUB}/v1/projects/${pid}/stream`, cookieHeader(dev2), { onEvent: (seq, e) => d2.push(bodyOf(e)), onControl: (n) => { if (n === "revoked") d2Revoked = true; } });
  await new Promise((r) => setTimeout(r, 1500));
  const me2 = (await dev2.expect(200, "GET", "/devices")).devices.find((d) => d.current).id;
  const t0 = Date.now();
  await dev1.expect(204, "DELETE", `/devices/${me2}`).catch(async () => {
    const r = await dev1.call("DELETE", `/devices/${me2}`);
    assert.equal(r.status, 204);
  });
  await waitFor(() => d2Revoked, 5000, "revoked event on old stream");
  const revokeMs = Date.now() - t0;
  await say(dev1, pid, "[m4] after revoke");
  await waitFor(() => d1.includes("[m4] after revoke"), 10_000, "dev1 still live");
  await new Promise((r) => setTimeout(r, 1500));
  const leaked = d2.includes("[m4] after revoke");
  const dev2Api = (await dev2.call("GET", `/projects/${pid}/tasks`)).status;
  step(`B: device 2 stream revoked in ${revokeMs}ms; device 1 still live; device 2 got post-revoke event: ${leaked}; device 2 API: ${dev2Api}`);
  await say(dev1, pid, `[m4] B revoke ${!leaked && dev2Api === 401 ? "OK" : "FAIL"}: revoked stream closed in ${revokeMs}ms, other device live, revoked API ${dev2Api}`);
  f1.stop();
  f2.stop();
  assert.ok(!leaked && dev2Api === 401);
}

const phases = { prepare, a, b };
if (!phases[phase]) {
  console.error("usage: node scripts/e2e/m4.mjs prepare|a|b");
  process.exit(2);
}
await phases[phase]();
process.exit(0);
