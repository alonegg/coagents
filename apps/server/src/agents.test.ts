import { describe, expect, it } from "vitest";
import { Browser, PUBLIC_URL, seedUser, testEnv, type TestEnv } from "./test-helpers.js";

let n = 0;
const rid = () => `req-${++n}-${Math.random().toString(36).slice(2)}`;

// An agent speaks bearer-only JSON, like the Connector.
class Agent {
  constructor(private readonly env: TestEnv, public token: string) {}
  async json(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await this.env.app.request(`${PUBLIC_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

async function anon(env: TestEnv, method: string, path: string, body?: unknown) {
  return new Agent(env, "").json(method, path, body).catch(() => ({ status: 0, body: null }));
}

async function connect(env: TestEnv, person: Browser, projectId: string, scopes = ["read", "write"]): Promise<Agent> {
  const grantRes = await env.app.request(`${PUBLIC_URL}/v1/device-codes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: projectId, client_label: "Claude Code on laptop", scopes }),
  });
  const grant = (await grantRes.json()) as any;
  const poll = () =>
    Promise.resolve(
      env.app.request(`${PUBLIC_URL}/v1/device-codes/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: grant.device_code }),
      }),
    ).then(async (r: Response) => ({ status: r.status, body: (await r.json()) as any }));
  expect((await poll()).body).toEqual({ status: "pending" });
  expect((await person.json("POST", `/v1/device-codes/${grant.user_code}/approve`)).status).toBe(201);
  const done = await poll();
  expect(done.body.status).toBe("approved");
  expect((await poll()).status).toBe(404);
  return new Agent(env, done.body.agent_token);
}

async function setup() {
  const env = testEnv();
  const owner = await seedUser(env, "lin");
  const pid = (await owner.json("POST", "/v1/projects", { name: "p" })).body.id;
  const chen = await seedUser(env, "chen");
  const token = (await owner.json("POST", `/v1/projects/${pid}/invitations`, { role: "contributor" })).body.token;
  await chen.json("POST", `/v1/invitations/${token}/accept`);
  return { env, owner, chen, pid };
}

describe("device code authorization", () => {
  it("shows the request only to project members and needs agent.connect_own", async () => {
    const { env, owner, pid } = await setup();
    const outsider = await seedUser(env, "wang");
    const viewer = await seedUser(env, "zhou");
    const vt = (await owner.json("POST", `/v1/projects/${pid}/invitations`, { role: "viewer" })).body.token;
    await viewer.json("POST", `/v1/invitations/${vt}/accept`);
    const grant = (await (await env.app.request(`${PUBLIC_URL}/v1/device-codes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: pid, client_label: "x", scopes: ["read"] }),
    })).json()) as any;
    expect(grant.user_code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    expect(grant.verification_url).toBe(`${PUBLIC_URL}/#/device/${grant.user_code}`);
    expect((await outsider.json("GET", `/v1/device-codes/${grant.user_code}`)).status).toBe(404);
    expect((await viewer.json("GET", `/v1/device-codes/${grant.user_code.toLowerCase().replace("-", "")}`)).body.project_name).toBe("p");
    expect((await viewer.json("POST", `/v1/device-codes/${grant.user_code}/approve`)).status).toBe(403);
  });

  it("expires unapproved codes", async () => {
    const { env, chen, pid } = await setup();
    const grant = (await (await env.app.request(`${PUBLIC_URL}/v1/device-codes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: pid, client_label: "x", scopes: ["read"] }),
    })).json()) as any;
    env.advance(601_000);
    expect((await chen.json("POST", `/v1/device-codes/${grant.user_code}/approve`)).status).toBe(404);
  });
});

describe("agent access", () => {
  it("works within its project, never outside, and cannot review or manage", async () => {
    const { env, owner, chen, pid } = await setup();
    const other = (await chen.json("POST", "/v1/projects", { name: "chen's other" })).body.id;
    const agent = await connect(env, chen, pid);

    const t = await agent.json("POST", `/v1/projects/${pid}/tasks`, { title: "agent task", request_id: rid() });
    expect(t.status).toBe(201);
    expect((await agent.json("GET", `/v1/projects/${other}/tasks`)).status).toBe(404);
    expect((await agent.json("GET", `/v1/projects/${pid}/members`)).status).toBe(401);
    expect((await agent.json("POST", `/v1/projects/${pid}/invitations`, { role: "viewer" })).status).toBe(401);

    const claim = await agent.json("POST", `/v1/projects/${pid}/tasks/${t.body.id}/claim`, { request_id: rid() });
    expect(claim.body.task.holder).toMatchObject({ kind: "client", user_id: expect.any(String) });
    expect((await agent.json("POST", `/v1/projects/${pid}/tasks/${t.body.id}/release`, { request_id: rid() })).body.error.code).toBe("lease_invalid");
    const sub = await agent.json("POST", `/v1/projects/${pid}/tasks/${t.body.id}/submit`, {
      lease_token: claim.body.lease_token,
      summary: "done",
      evidence: "tests pass",
      request_id: rid(),
    });
    expect(sub.body.task.status).toBe("review");

    // Even an owner's agent cannot accept its own work.
    const ownerAgent = await connect(env, owner, pid);
    const accept = await ownerAgent.json("POST", `/v1/projects/${pid}/tasks/${t.body.id}/accept`, { expected_version: sub.body.task.version, request_id: rid() });
    expect(accept.status).toBe(403);

    const events = (await owner.json("GET", `/v1/projects/${pid}/events`)).body.events;
    expect(events.find((e: any) => e.kind === "task.submitted").actor.client_id).toMatch(/^cli_/);
  });

  it("respects read-only scope and role changes on the next request", async () => {
    const { env, owner, chen, pid } = await setup();
    const reader = await connect(env, chen, pid, ["read"]);
    expect((await reader.json("GET", `/v1/projects/${pid}/tasks`)).status).toBe(200);
    expect((await reader.json("POST", `/v1/projects/${pid}/tasks`, { title: "x", request_id: rid() })).status).toBe(403);

    const writer = await connect(env, chen, pid);
    expect((await writer.json("POST", `/v1/projects/${pid}/tasks`, { title: "x", request_id: rid() })).status).toBe(201);
    const chenId = (await chen.json("GET", "/v1/session")).body.user.id;
    await owner.json("PATCH", `/v1/projects/${pid}/members/${chenId}`, { role: "viewer" });
    expect((await writer.json("POST", `/v1/projects/${pid}/tasks`, { title: "y", request_id: rid() })).status).toBe(403);
  });

  it("is cut off by connection revocation, member removal and device revocation, and loses its leases", async () => {
    const { env, owner, chen, pid } = await setup();
    const t = (await owner.json("POST", `/v1/projects/${pid}/tasks`, { title: "t", request_id: rid() })).body;

    const a1 = await connect(env, chen, pid);
    await a1.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
    const list = (await chen.json("GET", `/v1/projects/${pid}/agents`)).body.agents;
    expect(list[0]).toMatchObject({ label: "Claude Code on laptop", scopes: ["read", "write"], verified_at: expect.any(String) });
    expect((await owner.req("DELETE", `/v1/projects/${pid}/agents/${list[0].id}`)).status).toBe(204);
    expect((await a1.json("GET", `/v1/projects/${pid}/tasks`)).status).toBe(401);
    expect((await owner.json("GET", `/v1/projects/${pid}/tasks/${t.id}`)).body.holder.lease_active).toBe(false);

    const a2 = await connect(env, chen, pid);
    const me = (await a2.json("GET", "/v1/agent/me")).body;
    expect(me).toMatchObject({ role: "contributor", project: { id: pid, name: "p" } });
    expect((await chen.req("DELETE", `/v1/devices/${me.device_id}`)).status).toBe(204);
    expect((await a2.json("GET", `/v1/projects/${pid}/tasks`)).status).toBe(401);

    const a3 = await connect(env, chen, pid);
    const chenId = (await chen.json("GET", "/v1/session")).body.user.id;
    await owner.req("DELETE", `/v1/projects/${pid}/members/${chenId}`);
    expect((await a3.json("GET", `/v1/projects/${pid}/tasks`)).status).toBe(401);
  });

  it("revokes itself on uninstall", async () => {
    const { env, chen, pid } = await setup();
    const a = await connect(env, chen, pid);
    expect((await a.json("DELETE", "/v1/agent/me")).status).toBe(204);
    expect((await a.json("GET", "/v1/agent/me")).status).toBe(401);
  });

  it("rejects unknown bearer tokens without falling back to cookies", async () => {
    const { env, pid, chen } = await setup();
    const res = await chen.req("GET", `/v1/projects/${pid}/tasks`, undefined, { authorization: "Bearer not-a-token" });
    expect(res.status).toBe(401);
    expect((await anon(env, "GET", `/v1/projects/${pid}/tasks`)).status).toBe(401);
  });
});
