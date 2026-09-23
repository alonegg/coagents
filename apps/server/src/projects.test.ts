import { describe, expect, it } from "vitest";
import { Browser, PASSWORD, seedUser, testEnv, type TestEnv } from "./test-helpers.js";

async function projectOf(b: Browser, name = "教学网站"): Promise<string> {
  const res = await b.json("POST", "/v1/projects", { name, description: "d" });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function invite(owner: Browser, projectId: string, role: string, extra: object = {}): Promise<string> {
  const res = await owner.json("POST", `/v1/projects/${projectId}/invitations`, { role, ...extra });
  expect(res.status).toBe(201);
  return res.body.token;
}

async function join(env: TestEnv, owner: Browser, projectId: string, username: string, role: string): Promise<Browser> {
  const b = await seedUser(env, username);
  const token = await invite(owner, projectId, role);
  expect((await b.json("POST", `/v1/invitations/${token}/accept`)).status).toBe(201);
  return b;
}

describe("projects", () => {
  it("makes the creator owner and hides projects from non-members exactly like missing ones", async () => {
    const env = testEnv();
    const lin = await seedUser(env, "lin");
    const chen = await seedUser(env, "chen");
    const pid = await projectOf(lin);
    expect((await lin.json("GET", `/v1/projects/${pid}`)).body.role).toBe("owner");

    const hidden = await chen.json("GET", `/v1/projects/${pid}`);
    const missing = await chen.json("GET", "/v1/projects/prj_doesnotexist");
    expect(hidden).toEqual(missing);
    expect(hidden.status).toBe(404);
    expect((await chen.json("GET", "/v1/projects")).body.projects).toEqual([]);
    expect((await chen.json("GET", `/v1/projects/${pid}/members`)).status).toBe(404);
  });

  it("requires sign-in", async () => {
    const env = testEnv();
    expect((await new Browser(env.app).json("GET", "/v1/projects")).status).toBe(401);
  });
});

describe("invitations", () => {
  it("registers via invitation without granting access until accepted", async () => {
    const env = testEnv();
    const lin = await seedUser(env, "lin");
    const pid = await projectOf(lin);
    const token = await invite(lin, pid, "viewer");

    const zhou = new Browser(env.app);
    const preview = await zhou.json("GET", `/v1/invitations/${token}`);
    expect(preview.body).toMatchObject({ project_name: "教学网站", role: "viewer", transferable: true });

    const reg = await zhou.json("POST", `/v1/invitations/${token}/register`, {
      username: "zhou",
      display_name: "周",
      password: PASSWORD,
      timezone: "Europe/Berlin",
    });
    expect(reg.status).toBe(201);
    zhou.csrf = reg.body.csrf_token;
    expect((await zhou.json("GET", `/v1/projects/${pid}`)).status).toBe(404);

    expect((await zhou.json("POST", `/v1/invitations/${token}/accept`)).status).toBe(201);
    expect((await zhou.json("GET", `/v1/projects/${pid}`)).body.role).toBe("viewer");

    // One-time: the used token is dead for everyone.
    const other = await seedUser(env, "wang");
    expect((await other.json("POST", `/v1/invitations/${token}/accept`)).body.error.code).toBe("invitation_invalid");
    expect((await new Browser(env.app).json("GET", `/v1/invitations/${token}`)).status).toBe(404);
  });

  it("rejects expired, revoked and mistargeted invitations", async () => {
    const env = testEnv();
    const lin = await seedUser(env, "lin");
    const chen = await seedUser(env, "chen");
    const pid = await projectOf(lin);

    const expiring = await invite(lin, pid, "contributor", { expires_in_hours: 1 });
    env.advance(3600_000);
    expect((await chen.json("POST", `/v1/invitations/${expiring}/accept`)).body.error.code).toBe("invitation_invalid");

    const targeted = await invite(lin, pid, "contributor", { target_username: "wang" });
    expect((await chen.json("POST", `/v1/invitations/${targeted}/accept`)).status).toBe(403);
    const reg = await new Browser(env.app).json("POST", `/v1/invitations/${targeted}/register`, {
      username: "chen2",
      display_name: "x",
      password: PASSWORD,
      timezone: "UTC",
    });
    expect(reg.status).toBe(403);

    const revoked = await lin.json("POST", `/v1/projects/${pid}/invitations`, { role: "viewer" });
    expect((await lin.req("DELETE", `/v1/projects/${pid}/invitations/${revoked.body.id}`)).status).toBe(204);
    expect((await chen.json("POST", `/v1/invitations/${revoked.body.token}/accept`)).status).toBe(404);

    const states = (await lin.json("GET", `/v1/projects/${pid}/invitations`)).body.invitations.map((i: any) => i.state);
    expect(states.sort()).toEqual(["expired", "pending", "revoked"]);
  });

  it("does not let registration take an existing username", async () => {
    const env = testEnv();
    const lin = await seedUser(env, "lin");
    const token = await invite(lin, await projectOf(lin), "viewer");
    const res = await new Browser(env.app).json("POST", `/v1/invitations/${token}/register`, {
      username: "lin",
      display_name: "x",
      password: PASSWORD,
      timezone: "UTC",
    });
    expect(res.body.error.code).toBe("username_taken");
  });

  it("refuses to add an existing member twice", async () => {
    const env = testEnv();
    const lin = await seedUser(env, "lin");
    const pid = await projectOf(lin);
    const chen = await join(env, lin, pid, "chen", "viewer");
    const again = await invite(lin, pid, "admin");
    expect((await chen.json("POST", `/v1/invitations/${again}/accept`)).body.error.code).toBe("already_member");
  });
});

describe("membership management", () => {
  it("enforces the role matrix for inviting and managing members", async () => {
    const env = testEnv();
    const owner = await seedUser(env, "lin");
    const pid = await projectOf(owner);
    const admin = await join(env, owner, pid, "an", "admin");
    const contributor = await join(env, owner, pid, "chen", "contributor");
    const viewer = await join(env, owner, pid, "zhou", "viewer");

    for (const b of [contributor, viewer]) {
      expect((await b.json("POST", `/v1/projects/${pid}/invitations`, { role: "viewer" })).status).toBe(403);
      expect((await b.json("GET", `/v1/projects/${pid}/audit`)).status).toBe(403);
    }
    expect((await admin.json("POST", `/v1/projects/${pid}/invitations`, { role: "viewer" })).status).toBe(201);

    const ids = Object.fromEntries(
      (await owner.json("GET", `/v1/projects/${pid}/members`)).body.members.map((m: any) => [m.username, m.user_id]),
    );
    // Admin cannot touch the owner or themselves, can manage others.
    expect((await admin.json("PATCH", `/v1/projects/${pid}/members/${ids.lin}`, { role: "viewer" })).status).toBe(403);
    expect((await admin.json("PATCH", `/v1/projects/${pid}/members/${ids.an}`, { role: "viewer" })).status).toBe(403);
    expect((await admin.json("PATCH", `/v1/projects/${pid}/members/${ids.zhou}`, { role: "contributor" })).status).toBe(200);
    // Nobody can grant owner through a role change.
    expect((await owner.json("PATCH", `/v1/projects/${pid}/members/${ids.chen}`, { role: "owner" })).status).toBe(400);
    expect((await admin.json("POST", `/v1/projects/${pid}/ownership-transfer`, { user_id: ids.an })).status).toBe(403);

    // Removal takes effect on the removed member's next request.
    expect((await admin.req("DELETE", `/v1/projects/${pid}/members/${ids.chen}`)).status).toBe(204);
    expect((await contributor.json("GET", `/v1/projects/${pid}`)).status).toBe(404);

    const actions = (await owner.json("GET", `/v1/projects/${pid}/audit`)).body.records.map((r: any) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["member.role_change", "member.remove", "invitation.accept"]));
  });

  it("transfers ownership only on the target's acceptance and keeps exactly one owner", async () => {
    const env = testEnv();
    const owner = await seedUser(env, "lin");
    const pid = await projectOf(owner);
    const chen = await join(env, owner, pid, "chen", "contributor");
    const chenId = (await chen.json("GET", "/v1/session")).body.user.id;

    expect((await owner.json("POST", `/v1/projects/${pid}/ownership-transfer`, { user_id: chenId })).status).toBe(201);
    expect((await owner.json("POST", `/v1/projects/${pid}/ownership-transfer`, { user_id: chenId })).status).toBe(409);
    expect((await owner.json("POST", `/v1/projects/${pid}/ownership-transfer/accept`)).status).toBe(404);
    expect((await chen.json("GET", `/v1/projects/${pid}`)).body.role).toBe("contributor");

    expect((await chen.json("POST", `/v1/projects/${pid}/ownership-transfer/accept`)).body.role).toBe("owner");
    const roles = (await chen.json("GET", `/v1/projects/${pid}/members`)).body.members.map((m: any) => [m.username, m.role]);
    expect(roles).toEqual([
      ["chen", "owner"],
      ["lin", "admin"],
    ]);
  });
});
