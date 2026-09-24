// Cross-working-copy handoff on one machine with real git: the receiver's clone lacks the commit,
// acceptance is refused with a reason and nothing in the clone changes; after a fetch it succeeds.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { bindProject } from "../packages/connector/src/login.js";
import { createConnectorServer } from "../packages/connector/src/server.js";
import type { Credential } from "../packages/connector/src/store.js";
import { liveServer, signIn } from "./helpers.js";

let srv: Awaited<ReturnType<typeof liveServer>>;
beforeAll(async () => (srv = await liveServer()));
afterAll(() => srv.close());

const g = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

async function agentFor(session: Awaited<ReturnType<typeof signIn>>, pid: string, workdir: string) {
  const grant = await (await fetch(`${srv.base}/v1/device-codes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: pid, client_label: "t", scopes: ["read", "write"] }) })).json() as any;
  await session.call("POST", `/device-codes/${grant.user_code}/approve`);
  const tok = await (await fetch(`${srv.base}/v1/device-codes/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_code: grant.device_code }) })).json() as any;
  const cred: Credential = { server: srv.base, project_id: pid, client_id: tok.client_id, device_id: tok.device_id, scopes: tok.scopes, agent_token: tok.agent_token, created_at: "" };
  bindProject(workdir, srv.base, pid);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createConnectorServer({ ok: true, credential: cred, home: mkdtempSync(join(tmpdir(), "coagents-home-")), workdir }).connect(b);
  const mcp = new Client({ name: "t", version: "0" });
  await mcp.connect(a);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError ?? false, value: JSON.parse(r.content[0]!.text) };
  };
}

it("refuses to take over until the commit is fetched, and never touches the receiver's working copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "coagents-git-"));
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const a = join(root, "a");
  execFileSync("git", ["clone", "-q", remote, a]);
  writeFileSync(join(a, "README.md"), "v1\n");
  g(a, "add", "."), g(a, "commit", "-qm", "v1"), g(a, "push", "-q", "origin", "HEAD:main");
  const b = join(root, "b");
  execFileSync("git", ["clone", "-q", remote, b]);
  g(a, "checkout", "-qb", "feat/login");
  writeFileSync(join(a, "login.ts"), "export {}\n");
  g(a, "add", "."), g(a, "commit", "-qm", "login");

  const owner = await signIn(srv.base, srv.ctx, "g-owner");
  const other = await signIn(srv.base, srv.ctx, "g-other");
  const pid = (await owner.call("POST", "/projects", { name: "git" })).body.id;
  const inv = (await owner.call("POST", `/projects/${pid}/invitations`, { role: "contributor" })).body.token;
  await other.call("POST", `/invitations/${inv}/accept`);
  const sender = await agentFor(owner, pid, a);
  const receiver = await agentFor(other, pid, b);

  const task = (await sender("create_task", { title: "登录" })).value;
  await sender("claim_task", { task_id: task.id });
  const unpushed = await sender("prepare_handoff", { task_id: task.id, summary: "登录页完成", next_steps: ["接 API"] });
  expect(unpushed.value.error.code).toBe("handoff_blocked");
  g(a, "push", "-q", "origin", "feat/login");
  writeFileSync(join(a, "scratch.txt"), "wip\n");
  expect((await sender("prepare_handoff", { task_id: task.id, summary: "x", next_steps: ["y"] })).value.error.message).toMatch(/uncommitted/);
  execFileSync("rm", [join(a, "scratch.txt")]);
  const h = (await sender("prepare_handoff", { task_id: task.id, summary: "登录页完成", next_steps: ["接 API"] })).value;
  expect(h.git).toMatchObject({ branch: "feat/login", dirty: false, pushed: true, commit: g(a, "rev-parse", "HEAD") });

  const headBefore = g(b, "rev-parse", "HEAD");
  const refused = await receiver("accept_handoff", { handoff_id: h.id });
  expect(refused.isError).toBe(true);
  expect(refused.value.error.message).toContain("fetch feat/login");
  expect(g(b, "rev-parse", "HEAD")).toBe(headBefore);
  expect(g(b, "status", "--porcelain", "--", ".", ":(exclude).coagents")).toBe("");

  g(b, "fetch", "-q", "origin");
  const ok = await receiver("accept_handoff", { handoff_id: h.id });
  expect(ok.isError).toBe(false);
  expect(ok.value.local_check).toMatchObject({ has_commit: true, dirty: false });
  expect(g(b, "rev-parse", "HEAD")).toBe(headBefore);
  expect((await receiver("list_tasks", { status: "in_progress" })).value.tasks[0].holder.kind).toBe("agent");
  expect((await receiver("submit_task", { task_id: task.id, summary: "接手后完成", evidence: "ok" })).value.task.status).toBe("review");
});
