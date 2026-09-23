import { describe, expect, it } from "vitest";
import { Browser, seedUser, testEnv, type TestEnv } from "./test-helpers.js";

let n = 0;
const rid = () => `req-${++n}-${Math.random().toString(36).slice(2)}`;

interface Team {
  env: TestEnv;
  pid: string;
  owner: Browser;
  chen: Browser;
  zhou: Browser;
}

async function team(): Promise<Team> {
  const env = testEnv();
  const owner = await seedUser(env, "lin");
  const pid = (await owner.json("POST", "/v1/projects", { name: "p" })).body.id;
  const members: Record<string, Browser> = {};
  for (const [name, role] of [
    ["chen", "contributor"],
    ["zhou", "viewer"],
  ] as const) {
    const b = await seedUser(env, name);
    const token = (await owner.json("POST", `/v1/projects/${pid}/invitations`, { role })).body.token;
    await b.json("POST", `/v1/invitations/${token}/accept`);
    members[name] = b;
  }
  return { env, pid, owner, chen: members.chen!, zhou: members.zhou! };
}

async function newTask(b: Browser, pid: string, title = "实现登录页") {
  const res = await b.json("POST", `/v1/projects/${pid}/tasks`, { title, acceptance_criteria: "能登录", request_id: rid() });
  expect(res.status).toBe(201);
  return res.body;
}

describe("tasks", () => {
  it("runs the full lifecycle with an event for every business change", async () => {
    const { pid, owner, chen } = await team();
    const t = await newTask(chen, pid);
    expect(t).toMatchObject({ status: "todo", version: 1, holder: null });

    const claim = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
    expect(claim.status).toBe(200);
    expect(claim.body.task).toMatchObject({ status: "in_progress", holder: { kind: "user", lease_active: true } });
    expect(claim.body.lease_token).toHaveLength(43);

    const noEvidence = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/submit`, { summary: "done", request_id: rid() });
    expect(noEvidence.status).toBe(400);
    const sub = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/submit`, {
      summary: "完成",
      evidence: "单元测试 12 项通过，commit abc123",
      request_id: rid(),
    });
    expect(sub.body.task).toMatchObject({ status: "review", holder: null });

    const version = sub.body.task.version;
    expect((await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/accept`, { expected_version: version, request_id: rid() })).status).toBe(403);
    const rejected = await owner.json("POST", `/v1/projects/${pid}/tasks/${t.id}/reject`, { expected_version: version, reason: "缺少截图", request_id: rid() });
    expect(rejected.body.status).toBe("todo");

    await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
    const sub2 = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/submit`, { summary: "补充", evidence: "截图已附", request_id: rid() });
    const accepted = await owner.json("POST", `/v1/projects/${pid}/tasks/${t.id}/accept`, { expected_version: sub2.body.task.version, request_id: rid() });
    expect(accepted.body.status).toBe("done");

    const detail = await owner.json("GET", `/v1/projects/${pid}/tasks/${t.id}`);
    expect(detail.body.submissions.map((s: any) => s.outcome)).toEqual(["accepted", "rejected"]);

    const kinds = (await owner.json("GET", `/v1/projects/${pid}/events`)).body.events.map((e: any) => e.kind);
    expect(kinds).toEqual([
      "task.created",
      "task.claimed",
      "task.submitted",
      "task.rejected",
      "task.claimed",
      "task.submitted",
      "task.accepted",
    ]);
  });

  it("lets only one of many concurrent claims win", async () => {
    const { env, pid, owner, chen } = await team();
    const t = await newTask(owner, pid);
    const other = new Browser(env.app, "Other/1");
    await other.login("chen");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => [owner, chen, other][i % 3]!.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(new Set(results.filter((r) => r.status !== 200).map((r) => r.body.error.code))).toEqual(new Set(["task_already_held"]));
  });

  it("lets a lapsed lease be taken over and never write again", async () => {
    const { env, pid, owner, chen } = await team();
    const t = await newTask(owner, pid);
    const first = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
    env.advance(31 * 60_000);

    const lapsed = await owner.json("GET", `/v1/projects/${pid}/tasks/${t.id}`);
    expect(lapsed.body).toMatchObject({ status: "in_progress", holder: { lease_active: false } });
    expect((await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/renew`, { request_id: rid() })).body.error.code).toBe("lease_invalid");

    expect((await owner.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() })).status).toBe(200);
    const stale = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/submit`, {
      lease_token: first.body.lease_token,
      summary: "x",
      evidence: "y",
      request_id: rid(),
    });
    expect(stale.body.error.code).toBe("lease_invalid");
  });

  it("renews without a version bump and keeps the lease alive", async () => {
    const { env, pid, chen } = await team();
    const t = await newTask(chen, pid);
    const claim = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
    env.advance(25 * 60_000);
    const renewed = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/renew`, { request_id: rid() });
    expect(renewed.body.task.version).toBe(claim.body.task.version);
    env.advance(25 * 60_000);
    expect((await chen.json("GET", `/v1/projects/${pid}/tasks/${t.id}`)).body.holder.lease_active).toBe(true);
  });

  it("requires the same device for a person without a lease token", async () => {
    const { env, pid, chen } = await team();
    const t = await newTask(chen, pid);
    const claim = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
    const laptop = new Browser(env.app, "Laptop/1");
    await laptop.login("chen");
    expect((await laptop.json("POST", `/v1/projects/${pid}/tasks/${t.id}/release`, { request_id: rid() })).body.error.code).toBe("lease_invalid");
    const withToken = await laptop.json("POST", `/v1/projects/${pid}/tasks/${t.id}/release`, { lease_token: claim.body.lease_token, request_id: rid() });
    expect(withToken.body.status).toBe("todo");
  });

  it("detects concurrent edits by version", async () => {
    const { pid, owner, chen } = await team();
    const t = await newTask(owner, pid);
    const a = await owner.json("PATCH", `/v1/projects/${pid}/tasks/${t.id}`, { expected_version: 1, title: "A", request_id: rid() });
    const b = await chen.json("PATCH", `/v1/projects/${pid}/tasks/${t.id}`, { expected_version: 1, title: "B", request_id: rid() });
    expect(a.status).toBe(200);
    expect(b.body.error.code).toBe("version_conflict");
    expect((await owner.json("GET", `/v1/projects/${pid}/tasks/${t.id}`)).body.title).toBe("A");
  });

  it("does not allow status changes outside the semantic actions", async () => {
    const { pid, owner } = await team();
    const t = await newTask(owner, pid);
    const res = await owner.json("PATCH", `/v1/projects/${pid}/tasks/${t.id}`, { expected_version: 1, status: "done", request_id: rid() });
    expect(res.status).toBe(400);
    const accept = await owner.json("POST", `/v1/projects/${pid}/tasks/${t.id}/accept`, { expected_version: 1, request_id: rid() });
    expect(accept.body.error.code).toBe("task_not_claimable");
  });

  it("keeps viewers read-only", async () => {
    const { pid, owner, zhou } = await team();
    const t = await newTask(owner, pid);
    expect((await zhou.json("GET", `/v1/projects/${pid}/tasks`)).body.tasks).toHaveLength(1);
    expect((await zhou.json("POST", `/v1/projects/${pid}/tasks`, { title: "x", request_id: rid() })).status).toBe(403);
    expect((await zhou.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() })).status).toBe(403);
    expect((await zhou.json("POST", `/v1/projects/${pid}/decisions`, { body: "x", request_id: rid() })).status).toBe(403);
  });

  it("lets owners terminate a lease with a reason", async () => {
    const { pid, owner, chen } = await team();
    const t = await newTask(owner, pid);
    const claim = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
    const v = claim.body.task.version;
    expect((await owner.json("POST", `/v1/projects/${pid}/tasks/${t.id}/terminate`, { expected_version: v, request_id: rid() })).status).toBe(400);
    const term = await owner.json("POST", `/v1/projects/${pid}/tasks/${t.id}/terminate`, { expected_version: v, reason: "长时间无进展", request_id: rid() });
    expect(term.body).toMatchObject({ status: "todo", holder: null });
    expect((await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/release`, { request_id: rid() })).body.error.code).toBe("lease_invalid");
  });
});

describe("idempotency", () => {
  it("replays a retried create instead of creating a duplicate", async () => {
    const { pid, owner } = await team();
    const body = { title: "只应创建一次", request_id: "req-fixed-0001" };
    const a = await owner.json("POST", `/v1/projects/${pid}/tasks`, body);
    const b = await owner.json("POST", `/v1/projects/${pid}/tasks`, body);
    expect(b).toEqual(a);
    expect((await owner.json("GET", `/v1/projects/${pid}/tasks`)).body.tasks).toHaveLength(1);
    expect((await owner.json("GET", `/v1/projects/${pid}/events`)).body.events).toHaveLength(1);
  });

  it("returns the original lease on a retried claim and rejects request_id reuse elsewhere", async () => {
    const { pid, chen } = await team();
    const t = await newTask(chen, pid);
    const a = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: "req-claim-0001" });
    const b = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: "req-claim-0001" });
    expect(b.body.lease_token).toBe(a.body.lease_token);
    const reused = await chen.json("POST", `/v1/projects/${pid}/tasks`, { title: "x", request_id: "req-claim-0001" });
    expect(reused.status).toBe(422);
  });

  it("scopes request ids per actor", async () => {
    const { pid, owner, chen } = await team();
    await owner.json("POST", `/v1/projects/${pid}/tasks`, { title: "a", request_id: "req-shared-01" });
    await chen.json("POST", `/v1/projects/${pid}/tasks`, { title: "b", request_id: "req-shared-01" });
    expect((await owner.json("GET", `/v1/projects/${pid}/tasks`)).body.tasks).toHaveLength(2);
  });
});

describe("blockers and decisions", () => {
  it("blocks a held task, releases the lease, and allows reclaiming", async () => {
    const { pid, chen } = await team();
    const t = await newTask(chen, pid);
    await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
    const b = await chen.json("POST", `/v1/projects/${pid}/blockers`, { body: "缺少测试数据", task_id: t.id, request_id: rid() });
    expect(b.body.task).toMatchObject({ status: "blocked", holder: null });
    expect((await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() })).body.task.status).toBe("in_progress");
  });

  it("records a general blocker without touching tasks", async () => {
    const { pid, chen } = await team();
    const t = await newTask(chen, pid);
    const res = await chen.json("POST", `/v1/projects/${pid}/blockers`, { body: "CI 挂了", request_id: rid() });
    expect(res.status).toBe(201);
    expect((await chen.json("GET", `/v1/projects/${pid}/tasks/${t.id}`)).body.status).toBe("todo");
  });

  it("supersedes decisions once and keeps history", async () => {
    const { pid, owner, chen } = await team();
    const d1 = (await owner.json("POST", `/v1/projects/${pid}/decisions`, { body: "必须使用真实数据", request_id: rid() })).body;
    const [a, b] = await Promise.all([
      owner.json("POST", `/v1/projects/${pid}/decisions`, { body: "改用模拟数据", supersedes_id: d1.id, request_id: rid() }),
      chen.json("POST", `/v1/projects/${pid}/decisions`, { body: "继续等待", supersedes_id: d1.id, request_id: rid() }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const current = (await chen.json("GET", `/v1/projects/${pid}/decisions`)).body.decisions;
    expect(current).toHaveLength(1);
    expect(current[0].supersedes_id).toBe(d1.id);
    expect((await chen.json("GET", `/v1/projects/${pid}/decisions?history=1`)).body.decisions).toHaveLength(2);
  });

  it("does not reveal decisions of another project", async () => {
    const env = testEnv();
    const lin = await seedUser(env, "lin");
    const other = await seedUser(env, "wang");
    const p1 = (await lin.json("POST", "/v1/projects", { name: "p1" })).body.id;
    const p2 = (await other.json("POST", "/v1/projects", { name: "p2" })).body.id;
    const d = (await lin.json("POST", `/v1/projects/${p1}/decisions`, { body: "secret", request_id: rid() })).body;
    const res = await other.json("POST", `/v1/projects/${p2}/decisions`, { body: "x", supersedes_id: d.id, request_id: rid() });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });
});

describe("events", () => {
  it("pages by cursor without skipping and keeps acknowledged cursors monotonic", async () => {
    const { pid, owner } = await team();
    for (let i = 0; i < 5; i++) await newTask(owner, pid, `t${i}`);
    const p1 = (await owner.json("GET", `/v1/projects/${pid}/events?limit=2`)).body;
    expect(p1).toMatchObject({ has_more: true });
    expect(p1.events).toHaveLength(2);
    const p2 = (await owner.json("GET", `/v1/projects/${pid}/events?limit=10&cursor=${p1.next_cursor}`)).body;
    expect(p2.has_more).toBe(false);
    const seqs = [...p1.events, ...p2.events].map((e: any) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(5);

    expect((await owner.json("POST", `/v1/projects/${pid}/cursor`, { seq: p1.next_cursor })).body.last_seen_seq).toBe(p1.next_cursor);
    expect((await owner.json("POST", `/v1/projects/${pid}/cursor`, { seq: 0 })).body.last_seen_seq).toBe(p1.next_cursor);
    expect((await owner.json("POST", `/v1/projects/${pid}/cursor`, { seq: 10_000 })).body.last_seen_seq).toBe(p2.next_cursor);
  });

  it("never carries lease tokens", async () => {
    const { pid, chen } = await team();
    const t = await newTask(chen, pid);
    const claim = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
    const events = JSON.stringify((await chen.json("GET", `/v1/projects/${pid}/events`)).body);
    expect(events).not.toContain(claim.body.lease_token);
    expect(JSON.stringify((await chen.json("GET", `/v1/projects/${pid}/tasks/${t.id}`)).body)).not.toContain(claim.body.lease_token);
  });
});
