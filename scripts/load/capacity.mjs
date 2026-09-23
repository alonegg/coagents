// Capacity test at the PRD scale (section 11): 20 projects x 200 tasks, >= 10k events, 10 members,
// 20 browser devices, 50 agent sessions each holding a live stream while reading and writing.
// Reports p50/p95/max per read type. Run from a machine with RTT <= 100 ms to the server.
//   node scripts/load/capacity.mjs setup   -> writes the load fixture to $LOAD_STATE (json)
//   node scripts/load/capacity.mjs run     -> 180 s of load, prints a latency table
//   node scripts/load/capacity.mjs cleanup -> soft-deletes the load projects
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { HubClient, env } from "../e2e/client.mjs";

const HUB = env("COAGENTS_HUB");
const STATE = process.env.LOAD_STATE ?? "";
const readState = () => JSON.parse(process.env.LOAD_STATE_JSON ?? readFileSync(STATE, "utf8"));
const PROJECTS = 20, TASKS = 200, MEMBERS = 10, AGENTS = 50, DURATION_MS = Number(process.env.LOAD_SECONDS ?? 180) * 1000;
const rid = () => `load-${randomUUID()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, n, fn) {
  const queue = [...items.entries()];
  await Promise.all(Array.from({ length: n }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await fn(next[1], next[0]);
  }));
}

async function setup() {
  const owner = new HubClient(HUB, "load-owner");
  await owner.login(env("E2E_OWNER_USER"), env("E2E_OWNER_PASSWORD"));
  const stamp = new Date().toISOString().slice(0, 16);
  const projects = [];
  for (let i = 0; i < PROJECTS; i++) projects.push((await owner.expect(201, "POST", "/projects", { name: `容量测试 ${stamp} #${i + 1}`, description: "压测数据，测试后删除" })).id);
  // Nine more members (ten with the owner), registered through invitations.
  const members = [{ username: env("E2E_OWNER_USER"), password: env("E2E_OWNER_PASSWORD") }];
  for (let m = 1; m < MEMBERS; m++) {
    const username = `load-${stamp.replace(/\D/g, "").slice(4)}-${m}`;
    const password = randomBytes(15).toString("base64url");
    const inv = await owner.expect(201, "POST", `/projects/${projects[0]}/invitations`, { role: "contributor", target_username: username });
    const c = new HubClient(HUB, username);
    c.adopt(await c.expect(201, "POST", `/invitations/${inv.token}/register`, { username, display_name: `压测成员 ${m}`, password, timezone: "Asia/Shanghai" }));
    for (const p of projects) {
      const t = await owner.expect(201, "POST", `/projects/${p}/invitations`, { role: "contributor", target_username: username });
      await c.expect(201, "POST", `/invitations/${t.token}/accept`);
    }
    members.push({ username, password });
  }
  console.log(`members: ${members.length}`);
  // 200 tasks per project, each created then claimed and released: three events per task.
  let n = 0;
  await pool(projects, 10, async (p) => {
    const o = new HubClient(HUB, `seed-${p}`);
    await o.login(env("E2E_OWNER_USER"), env("E2E_OWNER_PASSWORD"));
    for (let t = 0; t < TASKS; t++) {
      const task = await o.expect(201, "POST", `/projects/${p}/tasks`, { title: `压测任务 ${t + 1}`, acceptance_criteria: "无", request_id: rid() });
      await o.expect(200, "POST", `/projects/${p}/tasks/${task.id}/claim`, { request_id: rid() });
      await o.expect(200, "POST", `/projects/${p}/tasks/${task.id}/release`, { note: "压测", request_id: rid() });
      if (++n % 1000 === 0) console.log(`tasks seeded: ${n}`);
    }
  });
  // Fifty agent connections: five per member, spread over the projects.
  const agents = [];
  for (let a = 0; a < AGENTS; a++) {
    const m = members[a % MEMBERS];
    const person = new HubClient(HUB, `approve-${a}`);
    await person.login(m.username, m.password);
    const project = projects[a % PROJECTS];
    const grant = await person.expect(201, "POST", "/device-codes", { project_id: project, client_label: `load agent ${a}`, scopes: ["read", "write"] });
    await person.expect(201, "POST", `/device-codes/${grant.user_code}/approve`);
    const tok = await person.expect(200, "POST", "/device-codes/token", { device_code: grant.device_code });
    agents.push({ project, token: tok.agent_token });
  }
  writeFileSync(STATE, JSON.stringify({ projects, members, agents }), { mode: 0o600 });
  console.log(`setup done: ${projects.length} projects, ${n} tasks, ${agents.length} agents`);
}

async function run() {
  const { projects, members, agents } = readState();
  const lat = {};
  const errors = {};
  const record = (k, ms, ok) => {
    (lat[k] ??= []).push(ms);
    if (!ok) errors[k] = (errors[k] ?? 0) + 1;
  };
  const timed = async (k, fn) => {
    const t0 = performance.now();
    try {
      const r = await fn();
      record(k, performance.now() - t0, r.status < 500 && r.status !== 0);
      return r;
    } catch {
      record(k, performance.now() - t0, false);
      return { status: 0, body: null };
    }
  };
  const until = Date.now() + DURATION_MS;
  const streams = [];
  const rtt = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await fetch(`${HUB}/v1/health`);
    rtt.push(performance.now() - t0);
  }
  console.log(`baseline health request (includes network round trip): median ${Math.round(rtt.sort((a, b) => a - b)[2])} ms`);
  const agentLoop = async (a) => {
    const h = { authorization: `Bearer ${a.token}` };
    const call = async (method, path, body) => {
      const r = await fetch(`${HUB}/v1${path}`, { method, headers: { ...h, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    const ac = new AbortController();
    streams.push(ac);
    let delivered = 0;
    void fetch(`${HUB}/v1/projects/${a.project}/stream`, { headers: h, signal: ac.signal }).then(async (r) => {
      for await (const chunk of r.body) delivered += chunk.length;
    }).catch(() => {});
    while (Date.now() < until) {
      const board = await timed("agent: list 200 tasks", () => call("GET", `/projects/${a.project}/tasks`));
      await timed("agent: events page", () => call("GET", `/projects/${a.project}/events?cursor=0&limit=50`));
      const todo = board.body?.tasks?.filter((t) => t.status === "todo") ?? [];
      if (todo.length && Math.random() < 0.3) {
        const t = todo[Math.floor(Math.random() * todo.length)];
        const c = await timed("agent: claim (write)", () => call("POST", `/projects/${a.project}/tasks/${t.id}/claim`, { request_id: rid() }));
        if (c.status === 200) await timed("agent: release (write)", () => call("POST", `/projects/${a.project}/tasks/${t.id}/release`, { lease_token: c.body.lease_token, request_id: rid() }));
      }
      await sleep(1000 + Math.random() * 2000);
    }
    return delivered;
  };
  const deviceLoop = async (d) => {
    const m = members[d % members.length];
    const c = new HubClient(HUB, `load-device-${d}`);
    for (;;) {
      const ok = await timed("hub: sign in", async () => {
        await c.login(m.username, m.password);
        return { status: 201 };
      });
      if (ok.status === 201) break;
      if (Date.now() > until) return;
      await sleep(1000);
    }
    while (Date.now() < until) {
      await timed("hub: project cards (20 summaries)", () => c.call("GET", "/projects"));
      await timed("hub: board 200 tasks", () => c.call("GET", `/projects/${projects[Math.floor(Math.random() * projects.length)]}/tasks`));
      await timed("hub: cross-project activity", () => c.call("GET", "/activity?limit=50"));
      await sleep(2000 + Math.random() * 2000);
    }
  };
  const started = Date.now();
  const delivered = await Promise.all([
    ...agents.map((a) => agentLoop(a).catch((e) => (record("loop crashed", 0, false), console.error(e.message), 0))),
    ...Array.from({ length: 20 }, (_, d) => deviceLoop(d).catch((e) => (record("loop crashed", 0, false), console.error(e.message)))),
  ]);
  for (const s of streams) s.abort();
  const pct = (xs, q) => xs[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)];
  console.log(`\n${agents.length} agents with live streams + 20 browser devices for ${Math.round((Date.now() - started) / 1000)} s; stream bytes delivered: ${delivered.filter(Boolean).reduce((a, b) => a + b, 0)}`);
  console.log("| operation | requests | errors | p50 ms | p95 ms | max ms |\n| --- | --- | --- | --- | --- | --- |");
  for (const [k, xs] of Object.entries(lat)) {
    xs.sort((a, b) => a - b);
    console.log(`| ${k} | ${xs.length} | ${errors[k] ?? 0} | ${Math.round(pct(xs, 0.5))} | ${Math.round(pct(xs, 0.95))} | ${Math.round(xs[xs.length - 1])} |`);
  }
}

async function cleanup() {
  const { projects } = readState();
  const o = new HubClient(HUB, "cleanup");
  await o.login(env("E2E_OWNER_USER"), env("E2E_OWNER_PASSWORD"));
  for (const p of projects) await o.expect(204, "DELETE", `/projects/${p}`);
  console.log(`deleted ${projects.length} load projects (their agents are revoked)`);
}

await ({ setup, run, cleanup })[process.argv[2]]?.();
