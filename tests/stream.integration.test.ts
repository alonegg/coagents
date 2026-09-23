import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventStream, type StreamState } from "../packages/connector/src/sse.js";
import { liveServer, signIn, until, type Session } from "./helpers.js";

let srv: Awaited<ReturnType<typeof liveServer>>;
beforeAll(async () => (srv = await liveServer()));
afterAll(() => srv.close());

let n = 0;
const rid = () => `req-stream-${++n}-${Date.now()}`;

function open(s: Session, pid: string, cursor?: number) {
  const got: { seq: number; kind: string }[] = [];
  const states: StreamState[] = [];
  const stream = new EventStream({
    url: (c) => `${srv.base}/v1/projects/${pid}/stream${cursor === undefined && c === -1 ? "" : `?cursor=${c}`}`,
    headers: { cookie: s.cookie },
    cursor: cursor ?? -1,
    onEvent: (seq, data) => got.push({ seq, kind: (data as { kind: string }).kind }),
    onState: (st) => states.push(st),
    maxBackoffMs: 200,
  });
  void stream.run();
  return { got, states, stream };
}

async function project(owner: Session, name: string) {
  return (await owner.call("POST", "/projects", { name })).body.id as string;
}

async function join(owner: Session, pid: string, who: Session, role = "contributor") {
  const token = (await owner.call("POST", `/projects/${pid}/invitations`, { role })).body.token;
  await who.call("POST", `/invitations/${token}/accept`);
}

describe("project event stream", () => {
  it("delivers committed events live and resumes from a cursor without gaps", async () => {
    const owner = await signIn(srv.base, srv.ctx, "s-owner");
    const pid = await project(owner, "stream");
    const live = open(owner, pid);
    await until(() => (live.states.includes("live") ? true : undefined));
    await owner.call("POST", `/projects/${pid}/tasks`, { title: "a", request_id: rid() });
    await owner.call("POST", `/projects/${pid}/tasks`, { title: "b", request_id: rid() });
    await until(() => (live.got.length >= 2 ? true : undefined));
    live.stream.stop();

    // Events written while disconnected arrive after resuming from the last delivered seq.
    const last = live.got[live.got.length - 1]!.seq;
    await owner.call("POST", `/projects/${pid}/tasks`, { title: "c", request_id: rid() });
    await owner.call("POST", `/projects/${pid}/decisions`, { body: "d", request_id: rid() });
    const resumed = open(owner, pid, last);
    await until(() => (resumed.got.length >= 2 ? true : undefined));
    expect(resumed.got.map((g) => g.kind)).toEqual(["task.created", "decision.published"]);
    expect(resumed.got[0]!.seq).toBeGreaterThan(last);
    resumed.stream.stop();
  });

  it("ends the stream of a revoked device while another device keeps receiving", async () => {
    const owner = await signIn(srv.base, srv.ctx, "r-owner");
    const pid = await project(owner, "revoke");
    const phone = await signIn(srv.base, srv.ctx, "r-owner", false);
    const a = open(owner, pid);
    const b = open(phone, pid);
    await until(() => (a.states.includes("live") && b.states.includes("live") ? true : undefined));

    const devices = (await owner.call("GET", "/devices")).body.devices;
    const phoneDevice = devices.find((d: any) => !d.current).id;
    expect((await owner.call("DELETE", `/devices/${phoneDevice}`)).status).toBe(204);
    await until(() => (b.states.includes("revoked") ? true : undefined), 2000);

    await owner.call("POST", `/projects/${pid}/tasks`, { title: "after revoke", request_id: rid() });
    await until(() => (a.got.some((g) => g.kind === "task.created") ? true : undefined));
    await new Promise((r) => setTimeout(r, 200));
    expect(b.got).toEqual([]);
    a.stream.stop();
  });

  it("ends a removed member's stream immediately", async () => {
    const owner = await signIn(srv.base, srv.ctx, "m-owner");
    const chen = await signIn(srv.base, srv.ctx, "m-chen");
    const pid = await project(owner, "members");
    await join(owner, pid, chen);
    const s = open(chen, pid);
    await until(() => (s.states.includes("live") ? true : undefined));
    const chenId = (await chen.call("GET", "/session")).body.user.id;
    await owner.call("DELETE", `/projects/${pid}/members/${chenId}`);
    await until(() => (s.states.includes("revoked") ? true : undefined), 2000);
  });
});

describe("notifications", () => {
  it("notifies managers of submissions once, tracks delivery and read, and hides left projects", async () => {
    const owner = await signIn(srv.base, srv.ctx, "n-owner");
    const chen = await signIn(srv.base, srv.ctx, "n-chen");
    const pid = await project(owner, "notify");
    await join(owner, pid, chen);
    const t = (await owner.call("POST", `/projects/${pid}/tasks`, { title: "t", request_id: rid() })).body;

    // Stream the owner's notifications.
    const got: any[] = [];
    const ns = new EventStream({
      url: (c) => `${srv.base}/v1/notifications/stream?cursor=${c}`,
      headers: { cookie: owner.cookie },
      cursor: 0,
      onEvent: (_seq, data) => got.push(data),
      maxBackoffMs: 200,
    });
    void ns.run();

    await chen.call("POST", `/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
    await chen.call("POST", `/projects/${pid}/tasks/${t.id}/submit`, { summary: "s", evidence: "e", request_id: rid() });
    const n = await until(() => got.find((x) => x.kind === "task.submitted"));
    expect(n).toMatchObject({ project_name: "notify", unread: 1 });

    const list = (await owner.call("GET", "/notifications")).body;
    expect(list.notifications).toHaveLength(1);
    expect(list.notifications[0].delivered_at).not.toBeNull();
    expect(list.notifications[0].read_at).toBeNull();
    expect((await owner.call("POST", "/notifications/read", { ids: [list.notifications[0].id] })).body.unread).toBe(0);
    ns.stop();

    // Assignment notifies the assignee, not the actor.
    const chenId = (await chen.call("GET", "/session")).body.user.id;
    const v = (await owner.call("GET", `/projects/${pid}/tasks/${t.id}`)).body.version;
    expect((await owner.call("PATCH", `/projects/${pid}/tasks/${t.id}`, { expected_version: v, assignee_id: chenId, request_id: rid() })).status).toBe(200);
    expect((await chen.call("GET", "/notifications")).body.notifications.map((x: any) => x.kind)).toEqual(["task.assigned"]);
    expect((await owner.call("GET", "/notifications?unread=1")).body.notifications).toEqual([]);

    await owner.call("DELETE", `/projects/${pid}/members/${chenId}`);
    expect((await chen.call("GET", "/notifications")).body).toEqual({ notifications: [], unread: 0 });
  });
});
