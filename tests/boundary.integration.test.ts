// The human/agent boundary: people can pause agents (project or one connection), agents cannot
// cross human-only actions, agent interruptions are budgeted per person, and people can see what
// acts in their name and whether collaboration pays off.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createConnectorServer } from "../packages/connector/src/server.js";
import { liveServer, signIn } from "./helpers.js";

let srv: Awaited<ReturnType<typeof liveServer>>;
beforeAll(async () => (srv = await liveServer()));
afterAll(() => srv.close());

async function agentFor(session: Awaited<ReturnType<typeof signIn>>, pid: string) {
  const grant = (await (await fetch(`${srv.base}/v1/device-codes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: pid, client_label: "t", scopes: ["read", "write"] }) })).json()) as any;
  await session.call("POST", `/device-codes/${grant.user_code}/approve`);
  const tok = (await (await fetch(`${srv.base}/v1/device-codes/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_code: grant.device_code }) })).json()) as any;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createConnectorServer({ ok: true, credential: { server: srv.base, project_id: pid, client_id: tok.client_id, device_id: tok.device_id, scopes: tok.scopes, agent_token: tok.agent_token, created_at: "" }, home: mkdtempSync(join(tmpdir(), "h-")) }).connect(b);
  const mcp = new Client({ name: "t", version: "0" });
  await mcp.connect(a);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = r.content[0]!.text;
    if (text.startsWith("MCP error")) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };
  return { call, clientId: tok.client_id as string, token: tok.agent_token as string, close: () => mcp.close() };
}

async function team(name: string) {
  const owner = await signIn(srv.base, srv.ctx, `${name}-owner`);
  const dev = await signIn(srv.base, srv.ctx, `${name}-dev`);
  const pid = (await owner.call("POST", "/projects", { name })).body.id;
  const inv = (await owner.call("POST", `/projects/${pid}/invitations`, { role: "contributor" })).body.token;
  await dev.call("POST", `/invitations/${inv}/accept`);
  const ownerId = (await owner.call("GET", "/session")).body.user.id;
  const devId = (await dev.call("GET", "/session")).body.user.id;
  return { owner, dev, pid, ownerId, devId };
}

it("lets people pause agents for the project or one connection; reads keep working", async () => {
  const { owner, dev, pid } = await team("pause");
  const a1 = await agentFor(dev, pid);
  const a2 = await agentFor(dev, pid);
  const t = (await owner.call("POST", `/projects/${pid}/tasks`, { title: "t", request_id: "req-pause-t" })).body;

  expect((await dev.call("PUT", `/projects/${pid}/agent-policy`, { agents_paused: true })).status).toBe(403); // contributors cannot
  expect((await owner.call("PUT", `/projects/${pid}/agent-policy`, { agents_paused: true })).status).toBe(200);
  expect((await owner.call("GET", `/projects/${pid}`)).body.agents_paused_at).toEqual(expect.any(String));
  const refused = await a1.call("claim_task", { task_id: t.id });
  expect(refused.error).toMatchObject({ code: "agents_paused", hint: expect.stringContaining("Stop writing") });
  expect((await a1.call("list_tasks")).tasks).toHaveLength(1);
  expect((await a1.call("get_context")).acting_as.paused).toBe("project");
  await owner.call("PUT", `/projects/${pid}/agent-policy`, { agents_paused: false });

  // One connection paused by its own person; the other keeps working.
  expect((await dev.call("PUT", `/projects/${pid}/agents/${a1.clientId}/pause`, { paused: true })).status).toBe(200);
  expect((await a1.call("claim_task", { task_id: t.id })).error.code).toBe("agents_paused");
  expect((await a2.call("claim_task", { task_id: t.id })).task.status).toBe("in_progress");
  const events = (await owner.call("GET", `/projects/${pid}/events?cursor=0&limit=200`)).body.events.map((e: any) => e.kind);
  expect(events).toEqual(expect.arrayContaining(["project.agents_paused", "project.agents_resumed"]));

  // Human-only actions stay closed to agents whatever their role.
  const res = await fetch(`${srv.base}/v1/projects/${pid}/tasks/${t.id}/accept`, {
    method: "POST",
    headers: { authorization: `Bearer ${a2.token}`, "content-type": "application/json" },
    body: JSON.stringify({ expected_version: 1, request_id: "req-agent-accept" }),
  });
  expect(((await res.json()) as any).error.message).toContain("Only a person");
  await a1.close();
  await a2.close();
});

it("budgets agent interruptions per person and shows people what acts in their name", async () => {
  const { owner, dev, pid, ownerId } = await team("budget");
  await owner.call("PUT", `/projects/${pid}/agent-policy`, { interrupt_limit: 2 });
  const agent = await agentFor(dev, pid);
  const t = (await owner.call("POST", `/projects/${pid}/tasks`, { title: "t", request_id: "req-budget-t" })).body;
  const t2 = (await owner.call("POST", `/projects/${pid}/tasks`, { title: "t2", request_id: "req-budget-t2" })).body;
  const before = (await owner.call("GET", "/notifications")).body.unread;

  expect((await agent.call("request_help", { task_id: t.id, user_id: ownerId, note: "1" })).event_seq).toEqual(expect.any(Number));
  expect((await agent.call("request_help", { task_id: t.id, user_id: ownerId, note: "2" })).event_seq).toEqual(expect.any(Number));
  const third = await agent.call("request_help", { task_id: t.id, user_id: ownerId, note: "3" });
  expect(third.error).toMatchObject({ code: "attention_budget_exceeded", hint: expect.stringContaining("publish_blocker") });

  // A blocker naming the same person still goes through, but its notification is muted.
  await agent.call("claim_task", { task_id: t2.id });
  const blocked = await agent.call("publish_blocker", { task_id: t2.id, body: "要权限", kind: "needs_access", needs_from_user_id: ownerId });
  expect(blocked.task.status).toBe("blocked");
  const n = (await owner.call("GET", "/notifications")).body;
  expect(n.unread).toBe(before + 2);
  expect(n.notifications.filter((x: any) => x.muted).map((x: any) => x.kind)).toEqual(["blocker.reported"]);

  // People are not budgeted when they ask each other.
  for (const i of [1, 2, 3]) expect((await dev.call("POST", `/projects/${pid}/tasks/${t.id}/help-requests`, { user_id: ownerId, note: `h${i}`, request_id: `req-human-help-${i}` })).status).toBe(201);

  const mine = (await dev.call("GET", "/me/agents")).body.agents;
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ id: agent.clientId, project_name: "budget", interrupts_last_24h: 3, paused_at: null });
  expect(mine[0].recent[0].kind).toBe("blocker.reported");

  const m = (await owner.call("GET", `/projects/${pid}/metrics?days=30`)).body;
  expect(m.blocked).toMatchObject({ episodes: 1, now: 1 });
  expect(m.interruptions).toEqual([{ user_id: ownerId, name: "budget-owner", delivered: 2, muted: 1 }]);
  await agent.close();
});

it("measures review outcomes separately for people and agents", async () => {
  const { owner, dev, pid } = await team("metrics");
  const agent = await agentFor(dev, pid);
  const review = async (taskId: string, action: "accept" | "reject") => {
    const v = (await owner.call("GET", `/projects/${pid}/tasks/${taskId}`)).body.version;
    await owner.call("POST", `/projects/${pid}/tasks/${taskId}/${action}`, { expected_version: v, ...(action === "reject" ? { reason: "no" } : {}), request_id: `req-${action}-${taskId}-${v}` });
  };
  const a = (await owner.call("POST", `/projects/${pid}/tasks`, { title: "agent task", request_id: "req-metrics-a" })).body;
  await agent.call("claim_task", { task_id: a.id });
  await agent.call("submit_task", { task_id: a.id, summary: "v1", evidence: "x" });
  await review(a.id, "reject");
  await agent.call("claim_task", { task_id: a.id });
  await agent.call("submit_task", { task_id: a.id, summary: "v2", evidence: "x" });
  await review(a.id, "accept");
  const h = (await owner.call("POST", `/projects/${pid}/tasks`, { title: "human task", request_id: "req-metrics-h" })).body;
  await dev.call("POST", `/projects/${pid}/tasks/${h.id}/claim`, { request_id: "req-m-h-claim" });
  await dev.call("POST", `/projects/${pid}/tasks/${h.id}/submit`, { summary: "done", evidence: "x", request_id: "req-m-h-submit" });
  await review(h.id, "accept");

  const m = (await owner.call("GET", `/projects/${pid}/metrics?days=7`)).body;
  expect(m.reviews.agent).toMatchObject({ reviewed: 2, accepted: 1, acceptance_rate: 0.5 });
  expect(m.reviews.human).toMatchObject({ reviewed: 1, accepted: 1, acceptance_rate: 1 });
  expect(m.first_pass.agent).toMatchObject({ done: 1, first_pass: 0, rate: 0 });
  expect(m.first_pass.human).toMatchObject({ done: 1, first_pass: 1, rate: 1 });
  expect((await owner.call("GET", `/projects/${pid}/metrics?days=5`)).status).toBe(400);
  await agent.close();
});
