import { describe, expect, it } from "vitest";
import { seedUser, testEnv, type Browser } from "./test-helpers.js";

let n = 0;
const rid = () => `req-hof-${++n}-${Math.random().toString(36).slice(2)}`;
const SHA = "a".repeat(40);
const git = (over: object = {}) => ({ repo_identity: "git@github.com:team/app.git", branch: "feat/login", commit: SHA, dirty: false, pushed: true, ...over });

async function setup() {
  const env = testEnv();
  const owner = await seedUser(env, "lin");
  const pid = (await owner.json("POST", "/v1/projects", { name: "p" })).body.id as string;
  const people: Record<string, Browser> = {};
  const ids: Record<string, string> = {};
  for (const name of ["chen", "wang"]) {
    const b = await seedUser(env, name);
    const token = (await owner.json("POST", `/v1/projects/${pid}/invitations`, { role: "contributor" })).body.token;
    await b.json("POST", `/v1/invitations/${token}/accept`);
    people[name] = b;
    ids[name] = (await b.json("GET", "/v1/session")).body.user.id;
  }
  const task = (await owner.json("POST", `/v1/projects/${pid}/tasks`, { title: "登录页", request_id: rid() })).body;
  await people.chen!.json("POST", `/v1/projects/${pid}/tasks/${task.id}/claim`, { request_id: rid() });
  return { env, pid, owner, chen: people.chen!, wang: people.wang!, ids, task };
}

const prepare = (b: Browser, pid: string, taskId: string, extra: object = {}) =>
  b.json("POST", `/v1/projects/${pid}/tasks/${taskId}/handoffs`, { summary: "表单完成", next_steps: "接后端", git: git(), request_id: rid(), ...extra });

describe("handoffs", () => {
  it("refuses to hand over uncommitted or unpushed code and keeps the lease", async () => {
    const { pid, chen, task } = await setup();
    const dirty = await prepare(chen, pid, task.id, { git: git({ dirty: true }) });
    expect(dirty.body.error.code).toBe("handoff_blocked");
    expect((await prepare(chen, pid, task.id, { git: git({ pushed: false }) })).body.error.message).toMatch(/push/);
    expect((await chen.json("GET", `/v1/projects/${pid}/tasks/${task.id}`)).body.holder.lease_active).toBe(true);
  });

  it("only the holder can prepare, and preparing returns the task to todo with a directed notification", async () => {
    const { pid, chen, wang, ids, task } = await setup();
    expect((await prepare(wang, pid, task.id)).body.error.code).toBe("lease_invalid");
    const h = await prepare(chen, pid, task.id, { target_user_id: ids.wang });
    expect(h.status).toBe(201);
    expect(h.body).toMatchObject({ state: "pending", git: { repo_identity: "github.com/team/app", commit: SHA } });
    expect((await chen.json("GET", `/v1/projects/${pid}/tasks/${task.id}`)).body).toMatchObject({ status: "todo", holder: null });
    expect((await wang.json("GET", "/v1/notifications")).body.notifications.map((x: any) => x.kind)).toEqual(["handoff.prepared"]);
  });

  it("blocks acceptance while the commit is missing, records why, and succeeds once fetched", async () => {
    const { pid, chen, wang, ids, task } = await setup();
    const h = (await prepare(chen, pid, task.id, { target_user_id: ids.wang })).body;
    const accept = (check?: object, request_id = rid()) => wang.json("POST", `/v1/projects/${pid}/handoffs/${h.id}/accept`, { ...(check ? { check } : {}), request_id });

    expect((await accept()).body.error.message).toMatch(/through the Connector/);
    const missing = await accept({ repo_identity: "https://github.com/team/app", has_commit: false, dirty: false });
    expect(missing.body.error.code).toBe("handoff_check_failed");
    expect(missing.body.error.message).toContain(`commit ${SHA} is not in your working copy`);
    const recorded = (await chen.json("GET", `/v1/projects/${pid}/handoffs/${h.id}`)).body.last_check;
    expect(recorded).toMatchObject({ ok: false, reasons: [expect.stringContaining("fetch feat/login")] });

    const wrongRepo = await accept({ repo_identity: "git@github.com:team/other.git", has_commit: true, dirty: false });
    expect(wrongRepo.body.error.message).toContain("github.com/team/other");

    const ok = await accept({ repo_identity: "ssh://git@github.com/team/app.git", has_commit: true, dirty: true }, "req-accept-final");
    expect(ok.status).toBe(200);
    expect(ok.body.handoff).toMatchObject({ state: "accepted", last_check: { ok: true, warnings: [expect.stringContaining("uncommitted")] } });
    const again = await accept({ repo_identity: "https://github.com/team/app", has_commit: true, dirty: false }, "req-accept-final");
    expect(again.body.lease_token).toBe(ok.body.lease_token);
    expect((await wang.json("GET", `/v1/projects/${pid}/tasks/${task.id}`)).body.holder).toMatchObject({ user_id: ids.wang, lease_active: true });
    expect((await accept({ repo_identity: "https://github.com/team/app", has_commit: true, dirty: false })).status).toBe(409);
  });

  it("keeps directed handoffs for their target and loses a race to a direct claim cleanly", async () => {
    const { pid, owner, chen, wang, ids, task } = await setup();
    const h = (await prepare(chen, pid, task.id, { target_user_id: ids.wang })).body;
    const check = { repo_identity: "github.com/team/app", has_commit: true, dirty: false };
    expect((await owner.json("POST", `/v1/projects/${pid}/handoffs/${h.id}/accept`, { check, request_id: rid() })).status).toBe(403);
    await owner.json("POST", `/v1/projects/${pid}/tasks/${task.id}/claim`, { request_id: rid() });
    const lost = await wang.json("POST", `/v1/projects/${pid}/handoffs/${h.id}/accept`, { check, request_id: rid() });
    expect(lost.body.error.code).toBe("task_already_held");
    expect((await wang.json("GET", `/v1/projects/${pid}/handoffs/${h.id}`)).body.state).toBe("pending");
  });

  it("hands over non-code work by artifact versions without inventing git data", async () => {
    const { pid, chen, wang, task } = await setup();
    const a = (await chen.json("POST", `/v1/projects/${pid}/artifacts`, { title: "设计稿", kind: "link", url: "https://example.org/d", request_id: rid() })).body;
    const v = (await chen.json("POST", `/v1/projects/${pid}/artifacts/${a.id}/publish`, { expected_revision: 1, request_id: rid() })).body.versions[0].id;
    const h = (await chen.json("POST", `/v1/projects/${pid}/tasks/${task.id}/handoffs`, { summary: "设计完成", next_steps: "评审", artifact_version_ids: [v], request_id: rid() })).body;
    expect(h.git).toBeNull();
    const ok = await wang.json("POST", `/v1/projects/${pid}/handoffs/${h.id}/accept`, { request_id: rid() });
    expect(ok.body.handoff.state).toBe("accepted");
  });
});
