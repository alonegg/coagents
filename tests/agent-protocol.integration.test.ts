// Agent protocol 2 through the real MCP tools: checklist, evidence coverage, rejection read back by
// the agent, waiting for a person, typed blockers, author kinds and retry-safe writes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createConnectorServer, PROTOCOL_INSTRUCTIONS } from "../packages/connector/src/server.js";
import type { Credential } from "../packages/connector/src/store.js";
import { liveServer, signIn } from "./helpers.js";

let srv: Awaited<ReturnType<typeof liveServer>>;
beforeAll(async () => (srv = await liveServer()));
afterAll(() => srv.close());

async function agentFor(session: Awaited<ReturnType<typeof signIn>>, pid: string) {
  const grant = (await (await fetch(`${srv.base}/v1/device-codes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: pid, client_label: "t", scopes: ["read", "write"] }) })).json()) as any;
  await session.call("POST", `/device-codes/${grant.user_code}/approve`);
  const tok = (await (await fetch(`${srv.base}/v1/device-codes/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_code: grant.device_code }) })).json()) as any;
  const cred: Credential = { server: srv.base, project_id: pid, client_id: tok.client_id, device_id: tok.device_id, scopes: tok.scopes, agent_token: tok.agent_token, created_at: "" };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createConnectorServer({ ok: true, credential: cred, home: mkdtempSync(join(tmpdir(), "coagents-home-")), workdir: mkdtempSync(join(tmpdir(), "coagents-wd-")) }).connect(b);
  const mcp = new Client({ name: "t", version: "0" });
  await mcp.connect(a);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError ?? false, value: JSON.parse(r.content[0]!.text) };
  };
  return { call, mcp, clientId: tok.client_id as string };
}

it("runs claim → submit with evidence → rejection read back → resubmit → accept", async () => {
  const owner = await signIn(srv.base, srv.ctx, "p-owner");
  const dev = await signIn(srv.base, srv.ctx, "p-dev");
  const pid = (await owner.call("POST", "/projects", { name: "protocol" })).body.id;
  const inv = (await owner.call("POST", `/projects/${pid}/invitations`, { role: "contributor" })).body.token;
  await dev.call("POST", `/invitations/${inv}/accept`);
  const ownerId = (await owner.call("GET", "/session")).body.user.id;
  const devId = (await dev.call("GET", "/session")).body.user.id;
  const { call, mcp } = await agentFor(dev, pid);

  // The protocol reaches the model as server instructions and as a prompt.
  expect(mcp.getInstructions()).toBe(PROTOCOL_INSTRUCTIONS);
  expect((await mcp.listPrompts()).prompts.map((p) => p.name)).toEqual(["work"]);
  const tools = (await mcp.listTools()).tools;
  expect(tools.find((t) => t.name === "get_task")!.annotations).toMatchObject({ readOnlyHint: true });
  expect(tools.find((t) => t.name === "submit_task")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });

  const task = (
    await owner.call("POST", `/projects/${pid}/tasks`, {
      title: "登录接口",
      criteria: [{ text: "POST /login 返回 200" }, { text: "错误密码返回 401" }],
      assignee_id: devId,
      request_id: "req-task-0001",
    })
  ).body;
  expect(task.criteria).toEqual([{ id: "c1", text: "POST /login 返回 200" }, { id: "c2", text: "错误密码返回 401" }]);

  const ctx = (await call("get_context")).value;
  expect(ctx.workflow.length).toBeGreaterThan(3);
  expect(ctx.acting_as).toMatchObject({ user_id: devId, role: "contributor", lease_minutes: 30 });
  expect(ctx.my_work.assigned_to_you.map((t: any) => t.id)).toEqual([task.id]);
  expect(ctx.members.map((m: any) => m.user_id).sort()).toEqual([ownerId, devId].sort());
  expect(ctx.events.at(-1)).toMatchObject({ kind: "task.created", actor: { kind: "human", user_id: ownerId } });
  expect(ctx.events[0].project_id).toBeUndefined();
  await call("ack_events", { seq: ctx.next_cursor });

  await call("claim_task", { task_id: task.id });
  expect((await call("get_context")).value.my_work.holding.map((t: any) => t.id)).toEqual([task.id]);

  const bad = await call("submit_task", { task_id: task.id, summary: "x", evidence_items: [{ criterion_id: "c9", kind: "note", detail: "?" }] });
  expect(bad.value.error).toMatchObject({ code: "invalid_input", hint: expect.stringContaining("Fix the arguments") });
  const badKind = await call("submit_task", { task_id: task.id, summary: "x", evidence_items: [{ criterion_id: "c1", kind: "commit", ref: "main" }] });
  expect(badKind.value.error.message).toMatch(/full commit id/);

  const sub1 = (
    await call("submit_task", {
      task_id: task.id,
      summary: "实现了登录",
      evidence_items: [{ criterion_id: "c1", kind: "test", ref: "pnpm test login", result: "pass" }],
    })
  ).value;
  expect(sub1.coverage.map((c: any) => [c.criterion_id, c.status])).toEqual([["c1", "pass"], ["c2", "missing"]]);

  // The agent waits for the reviewer instead of polling; its own submit does not wake it.
  const waiting = call("wait_for_events", { timeout_seconds: 10 });
  const version = (await owner.call("GET", `/projects/${pid}/tasks/${task.id}`)).body.version;
  await owner.call("POST", `/projects/${pid}/tasks/${task.id}/reject`, { expected_version: version, reason: "缺少错误密码的测试", request_id: "req-reject-01" });
  const woke = (await waiting).value;
  expect(woke.timed_out).toBe(false);
  expect(woke.events.map((e: any) => e.kind)).toEqual(["task.rejected"]);
  expect(woke.events[0].actor.kind).toBe("human");

  const detail = (await call("get_task", { task_id: task.id })).value.task;
  expect(detail.status).toBe("todo");
  expect(detail.submissions[0]).toMatchObject({ outcome: "rejected", review_note: "缺少错误密码的测试", author_kind: "agent", reviewed_by_name: "p-owner" });
  expect(detail.submissions[0].coverage[1]).toMatchObject({ criterion_id: "c2", status: "missing" });
  // The submitting user is told in the Hub.
  expect((await dev.call("GET", "/notifications")).body.notifications.map((n: any) => n.kind)).toContain("task.rejected");

  await call("claim_task", { task_id: task.id });
  const sub2 = (
    await call("submit_task", {
      task_id: task.id,
      summary: "补上错误密码用例",
      evidence_items: [
        { criterion_id: "c1", kind: "test", ref: "pnpm test login", result: "pass" },
        { criterion_id: "c2", kind: "test", ref: "pnpm test login -t 401", result: "pass" },
      ],
    })
  ).value;
  expect(sub2.coverage.every((c: any) => c.status === "pass")).toBe(true);
  const v2 = (await owner.call("GET", `/projects/${pid}/tasks/${task.id}`)).body.version;
  expect((await owner.call("POST", `/projects/${pid}/tasks/${task.id}/accept`, { expected_version: v2, request_id: "req-accept-01" })).status).toBe(200);

  // Quiet project: the wait times out instead of hanging.
  const cursor = (await call("get_context")).value.next_cursor;
  const quiet = (await call("wait_for_events", { after_seq: cursor, timeout_seconds: 1 })).value;
  expect(quiet).toMatchObject({ timed_out: true, events: [] });
  await mcp.close();
});

it("keeps checklist ids stable, types blockers, labels authors and dedupes retried writes", async () => {
  const owner = await signIn(srv.base, srv.ctx, "q-owner");
  const pid = (await owner.call("POST", "/projects", { name: "protocol-2" })).body.id;
  const ownerId = (await owner.call("GET", "/session")).body.user.id;
  const { call } = await agentFor(owner, pid);

  const t = (await call("create_task", { title: "文档", criteria: ["覆盖安装", "覆盖登录"] })).value;
  expect(t.criteria.map((c: any) => c.id)).toEqual(["c1", "c2"]);
  const edited = (
    await owner.call("PATCH", `/projects/${pid}/tasks/${t.id}`, {
      expected_version: t.version,
      criteria: [{ id: "c2", text: "覆盖登录与登出" }, { text: "覆盖卸载" }],
      request_id: "req-edit-0001",
    })
  ).body;
  expect(edited.criteria).toEqual([{ id: "c2", text: "覆盖登录与登出" }, { id: "c3", text: "覆盖卸载" }]);
  const again = (await owner.call("PATCH", `/projects/${pid}/tasks/${t.id}`, { expected_version: edited.version, criteria: [{ id: "c1", text: "回来" }], request_id: "req-edit-0002" })).body;
  expect(again.error.code).toBe("invalid_input");

  await call("claim_task", { task_id: t.id });
  const nobody = await call("publish_blocker", { task_id: t.id, body: "需要仓库权限", kind: "needs_access", needs_from_user_id: "usr_nobody" });
  expect(nobody.value.error.code).toBe("invalid_input");
  const blocked = (await call("publish_blocker", { task_id: t.id, body: "需要仓库权限", kind: "needs_access", needs_from_user_id: ownerId })).value;
  expect(blocked.task.status).toBe("blocked");
  const ev = (await call("get_context", { cursor: 0, limit: 200 })).value.events.find((e: any) => e.kind === "blocker.reported");
  expect(ev.data).toMatchObject({ blocker_kind: "needs_access", needs_from_user_id: ownerId });

  const d1 = (await call("publish_decision", { body: "接口统一用 snake_case", request_id: "req-decision-7" })).value;
  const d2 = (await call("publish_decision", { body: "接口统一用 snake_case", request_id: "req-decision-7" })).value;
  expect(d2.id).toBe(d1.id);
  expect(d1.created_by_kind).toBe("agent");
  await owner.call("POST", `/projects/${pid}/decisions`, { body: "人定的规则", request_id: "req-decision-8" });
  const decisions = (await call("get_context")).value.current_decisions;
  expect(decisions.map((d: any) => d.created_by_kind).sort()).toEqual(["agent", "human"]);

  // Handoff next steps come back as a list and as numbered prose.
  await call("claim_task", { task_id: t.id });
  const h = (await call("prepare_handoff", { task_id: t.id, summary: "写了一半", next_steps: ["补卸载", "校对"], include_git: false })).value;
  expect(h).toMatchObject({ next_step_items: ["补卸载", "校对"], next_steps: "1. 补卸载\n2. 校对", from: { author_kind: "agent" } });
});
