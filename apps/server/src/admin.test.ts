import { describe, expect, it } from "vitest";
import { Browser, PASSWORD, seedUser, testEnv, type TestEnv } from "./test-helpers.js";

const application = (username: string) => ({
  username,
  display_name: "新成员",
  password: PASSWORD,
  timezone: "Asia/Shanghai",
  email: `${username}@example.org`,
  note: "数据组，需要参与教学网站项目",
});

async function applyAs(env: TestEnv, username: string) {
  return new Browser(env.app).json("POST", "/v1/registrations", application(username));
}

describe("registration by application", () => {
  it("keeps applicants out until a maintainer approves, and tells them why", async () => {
    const env = testEnv();
    const admin = await seedUser(env, "root", true);
    expect((await new Browser(env.app).json("GET", "/v1/instance")).body).toMatchObject({ registration_mode: "approval", site_name: "CoAgents" });
    expect((await applyAs(env, "newbie")).body).toEqual({ status: "pending" });
    expect((await applyAs(env, "newbie")).body.error.code).toBe("username_taken");
    expect((await applyAs(env, "root")).body.error.code).toBe("username_taken");

    const b = new Browser(env.app);
    expect((await b.json("POST", "/v1/session", { username: "newbie", password: PASSWORD })).body.error.code).toBe("registration_pending");
    expect((await b.json("POST", "/v1/session", { username: "newbie", password: "wrong password!" })).body.error.code).toBe("unauthenticated");

    const regs = (await admin.json("GET", "/v1/admin/registrations?status=pending")).body.registrations;
    expect(regs[0]).toMatchObject({ username: "newbie", email: "newbie@example.org", note: expect.stringContaining("数据组") });
    expect(JSON.stringify(regs)).not.toContain("password");
    const approved = await admin.json("POST", `/v1/admin/registrations/${regs[0].id}/approve`, {});
    expect(approved.body.user).toMatchObject({ username: "newbie", instance_role: "member" });
    expect(await b.login("newbie")).toBe(201);
    expect((await b.json("GET", "/v1/projects")).body.projects).toEqual([]);
  });

  it("requires a reason to reject and reports rejection at sign-in", async () => {
    const env = testEnv();
    const admin = await seedUser(env, "root", true);
    await applyAs(env, "spam");
    const id = (await admin.json("GET", "/v1/admin/registrations")).body.registrations[0].id;
    expect((await admin.json("POST", `/v1/admin/registrations/${id}/reject`, {})).status).toBe(400);
    expect((await admin.json("POST", `/v1/admin/registrations/${id}/reject`, { note: "无法确认身份" })).status).toBe(200);
    expect((await new Browser(env.app).json("POST", "/v1/session", { username: "spam", password: PASSWORD })).body.error.code).toBe("registration_rejected");
  });

  it("closes registration when the maintainer says so and limits applications per address", async () => {
    const env = testEnv();
    const admin = await seedUser(env, "root", true);
    await admin.json("PUT", "/v1/admin/settings", { registration_mode: "closed", announcement: "内测中" });
    expect((await applyAs(env, "late")).body.error.code).toBe("registration_closed");
    expect((await new Browser(env.app).json("GET", "/v1/instance")).body).toMatchObject({ registration_mode: "closed", announcement: "内测中" });
    await admin.json("PUT", "/v1/admin/settings", { registration_mode: "approval" });
    // Attempts count against the per-address limit (5 per hour), including the refused one above.
    for (let i = 0; i < 4; i++) expect((await applyAs(env, `burst${i}`)).status).toBe(201);
    expect((await applyAs(env, "burst4")).status).toBe(429);
  });
});

describe("administration", () => {
  it("is invisible to non-maintainers", async () => {
    const env = testEnv();
    const member = await seedUser(env, "lin");
    for (const path of ["/v1/admin/overview", "/v1/admin/users", "/v1/admin/registrations", "/v1/admin/projects", "/v1/admin/audit"]) {
      expect((await member.json("GET", path)).status).toBe(404);
    }
  });

  it("manages accounts: temporary passwords force a change, disabling ends access, one maintainer must remain", async () => {
    const env = testEnv();
    const admin = await seedUser(env, "root", true);
    const lin = await seedUser(env, "lin");
    const linId = (await lin.json("GET", "/v1/session")).body.user.id;
    const rootId = (await admin.json("GET", "/v1/session")).body.user.id;

    const temp = (await admin.json("POST", `/v1/admin/users/${linId}/reset-password`)).body.temporary_password;
    expect((await lin.json("GET", "/v1/projects")).status).toBe(401);
    const fresh = new Browser(env.app);
    expect(await fresh.login("lin", temp)).toBe(201);
    expect((await fresh.json("GET", "/v1/session")).body.user.must_change_password).toBe(true);
    expect((await fresh.json("GET", "/v1/projects")).body.error.code).toBe("password_change_required");
    expect((await fresh.json("PUT", "/v1/session/password", { current_password: temp, new_password: "a new strong password" })).status).toBe(204);
    expect((await fresh.json("GET", "/v1/projects")).status).toBe(200);

    expect((await admin.json("POST", `/v1/admin/users/${rootId}/disable`)).status).toBe(403);
    expect((await admin.json("POST", `/v1/admin/users/${linId}/disable`)).status).toBe(200);
    expect((await fresh.json("GET", "/v1/projects")).status).toBe(401);
    expect((await admin.json("POST", `/v1/admin/users/${linId}/enable`)).status).toBe(200);
    expect(await new Browser(env.app).login("lin", "a new strong password")).toBe(201);

    await admin.json("POST", `/v1/admin/users/${linId}/role`, { instance_role: "maintainer" });
    const lin2 = new Browser(env.app);
    await lin2.login("lin", "a new strong password");
    expect((await lin2.json("GET", "/v1/admin/overview")).status).toBe(200);
    expect((await admin.json("POST", `/v1/admin/users/${rootId}/role`, { instance_role: "member" })).status).toBe(403);

    const actions = (await admin.json("GET", "/v1/admin/audit")).body.records.map((r: any) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["user.password_reset", "user.password_change", "user.disable", "user.enable", "user.role"]));
  });

  it("lets users change their own password, ending their other sessions", async () => {
    const env = testEnv();
    const a = await seedUser(env, "lin");
    const b = new Browser(env.app, "Other/1");
    await b.login("lin");
    expect((await a.json("PUT", "/v1/session/password", { current_password: "wrong", new_password: "another password 1" })).status).toBe(403);
    expect((await a.json("PUT", "/v1/session/password", { current_password: PASSWORD, new_password: "another password 1" })).status).toBe(204);
    expect((await a.json("GET", "/v1/session")).status).toBe(200);
    expect((await b.json("GET", "/v1/session")).status).toBe(401);
  });

  it("shows projects as metadata only and recovers ownership only when the owner is disabled", async () => {
    const env = testEnv();
    const admin = await seedUser(env, "root", true);
    const owner = await seedUser(env, "lin");
    const chen = await seedUser(env, "chen");
    const pid = (await owner.json("POST", "/v1/projects", { name: "教学网站", description: "机密说明" })).body.id;
    await owner.json("POST", `/v1/projects/${pid}/tasks`, { title: "机密任务", request_id: "req-admin-0001" });
    const token = (await owner.json("POST", `/v1/projects/${pid}/invitations`, { role: "contributor" })).body.token;
    await chen.json("POST", `/v1/invitations/${token}/accept`);
    const chenId = (await chen.json("GET", "/v1/session")).body.user.id;
    const ownerId = (await owner.json("GET", "/v1/session")).body.user.id;

    const list = (await admin.json("GET", "/v1/admin/projects")).body.projects;
    expect(list[0]).toMatchObject({ name: "教学网站", owner_username: "lin", members: 2, tasks: 1 });
    expect(JSON.stringify(list)).not.toContain("机密");
    expect((await admin.json("GET", `/v1/projects/${pid}`)).status).toBe(404);

    expect((await admin.json("POST", `/v1/admin/projects/${pid}/owner`, { user_id: chenId })).status).toBe(403);
    await admin.json("POST", `/v1/admin/users/${ownerId}/disable`);
    expect((await admin.json("POST", `/v1/admin/projects/${pid}/owner`, { user_id: chenId })).status).toBe(200);
    expect((await chen.json("GET", `/v1/projects/${pid}`)).body.role).toBe("owner");
  });

  it("reports runtime status", async () => {
    const env = testEnv();
    const admin = await seedUser(env, "root", true);
    await applyAs(env, "waiting");
    const o = (await admin.json("GET", "/v1/admin/overview")).body;
    expect(o).toMatchObject({ schema_version: 13, pending_registrations: 1, users: { active: 1 }, open_streams: 0 });
  });
});
