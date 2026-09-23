import { describe, expect, it } from "vitest";
import { Browser, seedUser, testEnv, type TestEnv } from "./test-helpers.js";

let n = 0;
const rid = () => `req-hub-${++n}-${Math.random().toString(36).slice(2)}`;

async function join(owner: Browser, pid: string, b: Browser, role: string) {
  const token = (await owner.json("POST", `/v1/projects/${pid}/invitations`, { role })).body.token;
  await b.json("POST", `/v1/invitations/${token}/accept`);
}

async function base() {
  const env = testEnv();
  const owner = await seedUser(env, "lin");
  const zhou = await seedUser(env, "zhou");
  const p1 = (await owner.json("POST", "/v1/projects", { name: "教学网站" })).body.id as string;
  const p2 = (await owner.json("POST", "/v1/projects", { name: "数据工具 100%" })).body.id as string;
  const p3 = (await owner.json("POST", "/v1/projects", { name: "私有项目" })).body.id as string;
  await join(owner, p1, zhou, "viewer");
  await join(owner, p2, zhou, "viewer");
  return { env, owner, zhou, p1, p2, p3 };
}

async function publish(env: TestEnv, b: Browser, pid: string, title: string) {
  const a = (await b.json("POST", `/v1/projects/${pid}/artifacts`, { title, kind: "markdown", body: "x", request_id: rid() })).body;
  await b.json("POST", `/v1/projects/${pid}/artifacts/${a.id}/publish`, { expected_revision: 1, request_id: rid() });
  return a.id as string;
}

describe("project cards", () => {
  it("summarize only what the viewer may see and filter by name literally", async () => {
    const { env, owner, zhou, p1 } = await base();
    await owner.json("POST", `/v1/projects/${p1}/tasks`, { title: "t", request_id: rid() });
    await publish(env, owner, p1, "公开周报");
    const zhouLast = (await zhou.json("GET", "/v1/projects")).body.projects.find((p: any) => p.id === p1).summary.last_activity_at;
    env.advance(60_000);
    const secret = await publish(env, owner, p1, "预算");
    await owner.json("PUT", `/v1/projects/${p1}/artifacts/${secret}/access`, { visibility: "restricted", user_ids: [], request_id: rid() });

    const card = (await zhou.json("GET", "/v1/projects")).body.projects.find((p: any) => p.id === p1);
    expect(card.summary.task_counts).toEqual({ todo: 1, in_progress: 0, blocked: 0, review: 0, done: 0 });
    expect(card.summary.recent_artifact.title).toBe("公开周报");
    expect(card.summary.last_activity_at).toBe(zhouLast);
    const ownerCard = (await owner.json("GET", "/v1/projects")).body.projects.find((p: any) => p.id === p1);
    expect(ownerCard.summary.recent_artifact.title).toBe("预算");

    expect((await zhou.json("GET", "/v1/projects")).body.projects.map((p: any) => p.name).sort()).toEqual(["教学网站", "数据工具 100%"]);
    expect((await zhou.json("GET", `/v1/projects?q=${encodeURIComponent("100%")}`)).body.projects.map((p: any) => p.name)).toEqual(["数据工具 100%"]);
    expect((await zhou.json("GET", `/v1/projects?q=${encodeURIComponent("%")}`)).body.projects).toHaveLength(1);
    expect((await zhou.json("GET", "/v1/projects?q=私有")).body.projects).toEqual([]);
  });
});

describe("archive, restore, delete", () => {
  it("makes an archived project read-only for people and agents, and restore does not revive removals", async () => {
    const { env, owner, zhou, p1 } = await base();
    const chen = await seedUser(env, "chen");
    await join(owner, p1, chen, "contributor");
    const chenId = (await chen.json("GET", "/v1/session")).body.user.id;
    await owner.req("DELETE", `/v1/projects/${p1}/members/${chenId}`);

    expect((await zhou.json("POST", `/v1/projects/${p1}/archive`)).status).toBe(403);
    expect((await owner.json("POST", `/v1/projects/${p1}/archive`)).body.lifecycle).toBe("archived");
    const blocked = await owner.json("POST", `/v1/projects/${p1}/tasks`, { title: "x", request_id: rid() });
    expect(blocked.body.error.code).toBe("project_archived");
    expect((await owner.json("POST", `/v1/projects/${p1}/decisions`, { body: "x", request_id: rid() })).body.error.code).toBe("project_archived");
    expect((await owner.json("POST", `/v1/projects/${p1}/invitations`, { role: "viewer" })).body.error.code).toBe("project_archived");
    expect((await zhou.json("GET", `/v1/projects/${p1}/tasks`)).status).toBe(200);
    expect((await zhou.json("GET", "/v1/projects")).body.projects.map((p: any) => p.id)).not.toContain(p1);
    expect((await zhou.json("GET", "/v1/projects?lifecycle=archived")).body.projects.map((p: any) => p.id)).toEqual([p1]);

    expect((await owner.json("POST", `/v1/projects/${p1}/restore`)).body.lifecycle).toBe("active");
    expect((await owner.json("POST", `/v1/projects/${p1}/tasks`, { title: "y", request_id: rid() })).status).toBe(201);
    expect((await chen.json("GET", `/v1/projects/${p1}`)).status).toBe(404);
  });

  it("lets only the owner delete, after which the project is gone for everyone", async () => {
    const { owner, zhou, p1 } = await base();
    const token = (await owner.json("POST", `/v1/projects/${p1}/invitations`, { role: "viewer" })).body.token;
    expect((await zhou.req("DELETE", `/v1/projects/${p1}`)).status).toBe(403);
    expect((await owner.req("DELETE", `/v1/projects/${p1}`)).status).toBe(204);
    for (const b of [owner, zhou]) {
      expect((await b.json("GET", `/v1/projects/${p1}`)).status).toBe(404);
      expect((await b.json("GET", "/v1/projects")).body.projects.map((p: any) => p.id)).not.toContain(p1);
    }
    expect((await owner.json("GET", `/v1/invitations/${token}`)).status).toBe(404);
    expect((await zhou.json("GET", "/v1/activity")).body.events.some((e: any) => e.project_id === p1)).toBe(false);
  });
});

describe("cross-project activity", () => {
  it("covers only the user's projects, hides restricted artifacts, and filters and pages", async () => {
    const { env, owner, zhou, p1, p2, p3 } = await base();
    await owner.json("POST", `/v1/projects/${p1}/tasks`, { title: "a", request_id: rid() });
    await owner.json("POST", `/v1/projects/${p2}/tasks`, { title: "b", request_id: rid() });
    await owner.json("POST", `/v1/projects/${p3}/tasks`, { title: "secret project task", request_id: rid() });
    const hidden = await publish(env, owner, p2, "受限报告");
    await owner.json("PUT", `/v1/projects/${p2}/artifacts/${hidden}/access`, { visibility: "restricted", user_ids: [], request_id: rid() });

    const all = (await zhou.json("GET", "/v1/activity")).body.events;
    expect(new Set(all.map((e: any) => e.project_id))).toEqual(new Set([p1, p2]));
    expect(JSON.stringify(all)).not.toContain("受限报告");
    expect(JSON.stringify(all)).not.toContain("secret project");
    expect((await owner.json("GET", "/v1/activity")).body.events.some((e: any) => e.subject_id === hidden)).toBe(true);

    const onlyP1 = (await zhou.json("GET", `/v1/activity?project_id=${p1}&kind=task.`)).body.events;
    expect(onlyP1.map((e: any) => e.kind)).toEqual(["task.created"]);
    const page1 = (await zhou.json("GET", "/v1/activity?limit=2")).body;
    const page2 = (await zhou.json("GET", `/v1/activity?limit=2&before=${page1.next_before}`)).body;
    expect(page2.events[0].seq).toBeLessThan(page1.events[1].seq);
  });
});
