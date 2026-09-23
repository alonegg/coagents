import { describe, expect, it } from "vitest";
import { seedUser, testEnv, type Browser } from "./test-helpers.js";

let n = 0;
const rid = () => `req-mil-${++n}-${Math.random().toString(36).slice(2)}`;

async function setup() {
  const env = testEnv();
  const owner = await seedUser(env, "lin");
  const pid = (await owner.json("POST", "/v1/projects", { name: "p", timezone: "Asia/Shanghai" })).body.id as string;
  const chen = await seedUser(env, "chen");
  const token = (await owner.json("POST", `/v1/projects/${pid}/invitations`, { role: "contributor" })).body.token;
  await chen.json("POST", `/v1/invitations/${token}/accept`);
  const tasks: any[] = [];
  for (const title of ["页面", "接口", "文档"]) tasks.push((await owner.json("POST", `/v1/projects/${pid}/tasks`, { title, request_id: rid() })).body);
  return { env, pid, owner, chen, tasks };
}

async function finish(owner: Browser, worker: Browser, pid: string, taskId: string) {
  await worker.json("POST", `/v1/projects/${pid}/tasks/${taskId}/claim`, { request_id: rid() });
  const s = await worker.json("POST", `/v1/projects/${pid}/tasks/${taskId}/submit`, { summary: "s", evidence: "e", request_id: rid() });
  await owner.json("POST", `/v1/projects/${pid}/tasks/${taskId}/accept`, { expected_version: s.body.task.version, request_id: rid() });
}

describe("milestones", () => {
  it("interprets a plain due date in the project's zone and derives overdue without changing state", async () => {
    const { env, pid, owner, chen } = await setup();
    const m = (await owner.json("POST", `/v1/projects/${pid}/milestones`, { title: "可演示版本", due_at: "2026-09-23", request_id: rid() })).body;
    expect(m.due_at).toBe("2026-09-23T15:59:59.999Z");
    expect(m).toMatchObject({ state: "open", overdue: false });
    expect((await chen.json("POST", `/v1/projects/${pid}/milestones`, { title: "x", request_id: rid() })).status).toBe(403);
    env.advance(20 * 3600_000);
    const later = (await chen.json("GET", `/v1/projects/${pid}/milestones`)).body.milestones[0];
    expect(later).toMatchObject({ state: "open", overdue: true });
  });

  it("requires reasoned scope changes and blocks achievement while linked tasks are unfinished", async () => {
    const { pid, owner, chen, tasks } = await setup();
    let m = (await owner.json("POST", `/v1/projects/${pid}/milestones`, { title: "M", request_id: rid() })).body;
    expect((await owner.json("POST", `/v1/projects/${pid}/milestones/${m.id}/scope`, { expected_version: m.version, add_task_ids: [tasks[0].id], request_id: rid() })).status).toBe(400);
    m = (await owner.json("POST", `/v1/projects/${pid}/milestones/${m.id}/scope`, { expected_version: m.version, add_task_ids: tasks.map((t) => t.id), reason: "首版范围", request_id: rid() })).body;
    expect(m.counts).toMatchObject({ total: 3, todo: 3, done: 0 });

    const other = (await owner.json("POST", `/v1/projects/${pid}/milestones`, { title: "N", request_id: rid() })).body;
    const clash = await owner.json("POST", `/v1/projects/${pid}/milestones/${other.id}/scope`, { expected_version: other.version, add_task_ids: [tasks[0].id], reason: "x", request_id: rid() });
    expect(clash.body.error.message).toMatch(/another milestone/);

    await finish(owner, chen, pid, tasks[0].id);
    await finish(owner, chen, pid, tasks[1].id);
    m = (await owner.json("GET", `/v1/projects/${pid}/milestones/${m.id}`)).body;
    const blocked = await owner.json("POST", `/v1/projects/${pid}/milestones/${m.id}/achieve`, { expected_version: m.version, note: "演示通过", request_id: rid() });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain("文档");

    m = (await owner.json("POST", `/v1/projects/${pid}/milestones/${m.id}/scope`, { expected_version: m.version, remove_task_ids: [tasks[2].id], reason: "文档移到下一版", request_id: rid() })).body;
    const ok = await owner.json("POST", `/v1/projects/${pid}/milestones/${m.id}/achieve`, { expected_version: m.version, note: "演示通过", request_id: rid() });
    expect(ok.body).toMatchObject({ state: "achieved", confirm_note: "演示通过", counts: { total: 2, done: 2 } });

    const events = (await chen.json("GET", `/v1/projects/${pid}/events?limit=200`)).body.events.filter((e: any) => e.subject_type === "milestone");
    expect(events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["milestone.scope_changed", "milestone.achieved"]));
    expect(events.find((e: any) => e.data.reason === "文档移到下一版").data.removed).toEqual([tasks[2].id]);

    const reopened = await owner.json("POST", `/v1/projects/${pid}/milestones/${m.id}/reopen`, { expected_version: ok.body.version, note: "演示发现问题", request_id: rid() });
    expect(reopened.body.state).toBe("open");
  });

  it("sets task and project due dates with version checks", async () => {
    const { env, pid, owner, chen, tasks } = await setup();
    const t = (await chen.json("PUT", `/v1/projects/${pid}/tasks/${tasks[0].id}/due`, { expected_version: 1, due_at: "2026-09-23", request_id: rid() })).body;
    expect(t).toMatchObject({ due_at: "2026-09-23T15:59:59.999Z", overdue: false });
    expect((await chen.json("PUT", `/v1/projects/${pid}/tasks/${tasks[0].id}/due`, { expected_version: 1, due_at: null, request_id: rid() })).status).toBe(409);
    env.advance(20 * 3600_000);
    expect((await chen.json("GET", `/v1/projects/${pid}/tasks/${tasks[0].id}`)).body).toMatchObject({ status: "todo", overdue: true });
    expect((await chen.json("PUT", `/v1/projects/${pid}/due`, { due_at: "2026-12-31", request_id: rid() })).status).toBe(403);
    expect((await owner.json("PUT", `/v1/projects/${pid}/due`, { due_at: "2026-12-31", request_id: rid() })).body.due_at).toBe("2026-12-31T15:59:59.999Z");
  });
});
