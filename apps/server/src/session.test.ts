import { describe, expect, it } from "vitest";
import { Browser, PUBLIC_URL, seedUser, testEnv } from "./test-helpers.js";
import { resetPassword } from "./users.js";

describe("health", () => {
  it("reports version and schema", async () => {
    const env = testEnv();
    const res = await new Browser(env.app).json("GET", "/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", schema_version: 3 });
  });
});

describe("sessions", () => {
  it("signs in, reads the session and signs out", async () => {
    const env = testEnv();
    const lin = await seedUser(env, "lin", true);
    const me = await lin.json("GET", "/v1/session");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ username: "lin", instance_role: "maintainer" });
    expect(me.body.user).not.toHaveProperty("password_hash");

    const stolen = lin.sessionCookie()!;
    expect((await lin.req("DELETE", "/v1/session")).status).toBe(204);
    const replay = await env.app.request(`${PUBLIC_URL}/v1/session`, { headers: { cookie: `coagents_session=${stolen}` } });
    expect(replay.status).toBe(401);
  });

  it("rejects wrong passwords and unknown users alike", async () => {
    const env = testEnv();
    await seedUser(env, "lin");
    const b = new Browser(env.app);
    expect(await b.login("lin", "wrong password!")).toBe(401);
    expect(await b.login("nobody", "wrong password!")).toBe(401);
  });

  it("rate limits repeated failures and recovers after the window", async () => {
    const env = testEnv();
    await seedUser(env, "lin");
    const b = new Browser(env.app);
    for (let i = 0; i < 10; i++) expect(await b.login("lin", "bad password")).toBe(401);
    expect(await b.login("lin")).toBe(429);
    env.advance(15 * 60_000 + 1);
    expect(await b.login("lin")).toBe(201);
  });

  it("expires sessions after the TTL", async () => {
    const env = testEnv();
    const lin = await seedUser(env, "lin");
    env.advance(24 * 3600_000 + 1);
    expect((await lin.json("GET", "/v1/session")).status).toBe(401);
  });

  it("requires the CSRF token and same origin on cookie writes", async () => {
    const env = testEnv();
    const lin = await seedUser(env, "lin");
    const noToken = await lin.req("POST", "/v1/projects", { name: "x" }, { "x-csrf-token": "" });
    expect(noToken.status).toBe(403);
    const crossOrigin = await lin.req("POST", "/v1/projects", { name: "x" }, { origin: "https://evil.test" });
    expect(crossOrigin.status).toBe(403);
    expect((await lin.req("POST", "/v1/projects", { name: "x" }, { origin: PUBLIC_URL })).status).toBe(201);
  });

  it("password reset revokes every session of the user", async () => {
    const env = testEnv();
    const lin = await seedUser(env, "lin");
    await resetPassword(env.ctx, "lin", "a brand new password");
    expect((await lin.json("GET", "/v1/session")).status).toBe(401);
    expect(await new Browser(env.app).login("lin", "a brand new password")).toBe(201);
  });

  it("sets hardened cookies", async () => {
    const env = testEnv();
    await seedUser(env, "lin");
    const res = await env.app.request(`${PUBLIC_URL}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "lin", password: "correct horse battery" }),
    });
    for (const c of res.headers.getSetCookie()) {
      expect(c).toMatch(/HttpOnly/);
      expect(c).toMatch(/Secure/);
      expect(c).toMatch(/SameSite=Lax/);
    }
  });
});

describe("devices", () => {
  it("revoking one device ends its sessions without affecting another device", async () => {
    const env = testEnv();
    const laptop = await seedUser(env, "lin");
    const desktop = new Browser(env.app, "Desktop/2.0");
    await desktop.login("lin");
    const list = await laptop.json("GET", "/v1/devices");
    expect(list.body.devices).toHaveLength(2);
    const desktopId = list.body.devices.find((d: any) => !d.current).id;

    expect((await laptop.req("DELETE", `/v1/devices/${desktopId}`)).status).toBe(204);
    expect((await desktop.json("GET", "/v1/session")).status).toBe(401);
    expect((await laptop.json("GET", "/v1/session")).status).toBe(200);
  });

  it("reuses the browser device on re-login", async () => {
    const env = testEnv();
    const b = await seedUser(env, "lin");
    await b.req("DELETE", "/v1/session");
    await b.login("lin");
    expect((await b.json("GET", "/v1/devices")).body.devices).toHaveLength(1);
  });

  it("cannot revoke another user's device", async () => {
    const env = testEnv();
    const lin = await seedUser(env, "lin");
    const chen = await seedUser(env, "chen");
    const chenDevice = (await chen.json("GET", "/v1/devices")).body.devices[0].id;
    expect((await lin.req("DELETE", `/v1/devices/${chenDevice}`)).status).toBe(404);
  });
});
