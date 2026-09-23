import { MAX_FILE_BYTES } from "@coagents/contract";
import { describe, expect, it } from "vitest";
import { Browser, seedUser, testEnv, type TestEnv } from "./test-helpers.js";

let n = 0;
const rid = () => `req-art-${++n}-${Math.random().toString(36).slice(2)}`;

async function team() {
  const env = testEnv();
  const owner = await seedUser(env, "lin");
  const pid = (await owner.json("POST", "/v1/projects", { name: "p" })).body.id as string;
  const people: Record<string, Browser> = {};
  const ids: Record<string, string> = {};
  for (const [name, role] of [
    ["chen", "contributor"],
    ["wang", "contributor"],
    ["zhou", "viewer"],
  ] as const) {
    const b = await seedUser(env, name);
    const token = (await owner.json("POST", `/v1/projects/${pid}/invitations`, { role })).body.token;
    await b.json("POST", `/v1/invitations/${token}/accept`);
    people[name] = b;
    ids[name] = (await b.json("GET", "/v1/session")).body.user.id;
  }
  return { env, pid, owner, chen: people.chen!, wang: people.wang!, zhou: people.zhou!, ids };
}

async function draft(b: Browser, pid: string, body = "# 方案\n\n初稿", extra: object = {}) {
  const res = await b.json("POST", `/v1/projects/${pid}/artifacts`, { title: "接口方案", kind: "markdown", body, request_id: rid(), ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

async function publish(b: Browser, pid: string, art: { id: string }, revision = 1) {
  const res = await b.json("POST", `/v1/projects/${pid}/artifacts/${art.id}/publish`, { expected_revision: revision, request_id: rid() });
  expect(res.status).toBe(200);
  return res.body;
}

const titles = async (b: Browser, pid: string) => (await b.json("GET", `/v1/projects/${pid}/artifacts`)).body.artifacts.map((a: any) => a.title);
const eventKinds = async (b: Browser, pid: string) =>
  (await b.json("GET", `/v1/projects/${pid}/events`)).body.events.filter((e: any) => e.subject_type === "artifact").map((e: any) => e.kind);

describe("artifact lifecycle", () => {
  it("keeps drafts private, publishes immutable versions and keeps history", async () => {
    const { pid, owner, chen, wang, zhou } = await team();
    const a = await draft(chen, pid);
    expect(a).toMatchObject({ status: "draft", current_version: null, has_draft: true });
    expect(await titles(wang, pid)).toEqual([]);
    expect(await titles(zhou, pid)).toEqual([]);
    expect((await wang.json("GET", `/v1/projects/${pid}/artifacts/${a.id}`)).status).toBe(404);
    expect(await titles(owner, pid)).toEqual(["接口方案"]);
    expect(await eventKinds(owner, pid)).toEqual([]);

    const v1 = await publish(chen, pid, a);
    expect(v1).toMatchObject({ status: "published", current_version: 1, has_draft: false });
    expect(await titles(zhou, pid)).toEqual(["接口方案"]);

    // Editing a published artifact opens a working draft; readers keep seeing v1.
    const d = await chen.json("PATCH", `/v1/projects/${pid}/artifacts/${a.id}/draft`, { expected_revision: 0, body: "# 方案\n\n第二稿", request_id: rid() });
    expect(d.body.has_draft).toBe(true);
    const zv = (await zhou.json("GET", `/v1/projects/${pid}/artifacts/${a.id}`)).body.versions;
    expect(zv.map((v: any) => [v.state, v.version, v.body])).toEqual([["published", 1, "# 方案\n\n初稿"]]);

    const stale = await owner.json("PATCH", `/v1/projects/${pid}/artifacts/${a.id}/draft`, { expected_revision: 5, body: "x", request_id: rid() });
    expect(stale.body.error.code).toBe("version_conflict");
    await publish(chen, pid, a, 1);
    const versions = (await zhou.json("GET", `/v1/projects/${pid}/artifacts/${a.id}`)).body.versions.map((v: any) => v.version);
    expect(versions).toEqual([2, 1]);
    expect(await eventKinds(zhou, pid)).toEqual(["artifact.published", "artifact.version_published"]);
  });

  it("never updates a published version in place, even via SQL", async () => {
    const { env, pid, chen } = await team();
    const a = await draft(chen, pid);
    await publish(chen, pid, a);
    expect(() => env.ctx.db.prepare("UPDATE artifact_versions SET body = 'tampered' WHERE artifact_id = ?").run(a.id)).toThrow(/immutable/);
  });

  it("lets only authors and admins edit; viewers cannot create", async () => {
    const { pid, owner, chen, wang, zhou } = await team();
    const a = await draft(chen, pid);
    await publish(chen, pid, a);
    expect((await wang.json("PATCH", `/v1/projects/${pid}/artifacts/${a.id}/draft`, { expected_revision: 0, body: "x", request_id: rid() })).status).toBe(403);
    expect((await owner.json("PATCH", `/v1/projects/${pid}/artifacts/${a.id}/draft`, { expected_revision: 0, body: "x", request_id: rid() })).status).toBe(200);
    expect((await zhou.json("POST", `/v1/projects/${pid}/artifacts`, { title: "x", kind: "link", url: "https://example.org", request_id: rid() })).status).toBe(403);
  });

  it("records import provenance separately from the importer", async () => {
    const { pid, chen, ids } = await team();
    const a = await draft(chen, pid, "旧报告", { source_author: "张老师", source_at: "2025-03-01" });
    expect(a).toMatchObject({ source_author: "张老师", source_at: "2025-03-01", imported_by: ids.chen, author: { id: ids.chen } });
    const unknown = await draft(chen, pid, "无来源");
    expect(unknown).toMatchObject({ source_author: null, source_at: null, imported_by: null });
  });
});

describe("restricted artifacts", () => {
  it("hide from lists, counts, events, detail and downloads; apply immediately", async () => {
    const { pid, owner, chen, wang, zhou, ids } = await team();
    const up = await chen.upload(`/v1/projects/${pid}/files`, "预算.md", new TextEncoder().encode("# 预算\n机密"));
    expect(up.status).toBe(201);
    const a = (await chen.json("POST", `/v1/projects/${pid}/artifacts`, { title: "预算", kind: "file", file_id: up.body.id, request_id: rid() })).body;
    const pub = await publish(chen, pid, a);
    const vid = pub.versions[0].id;
    const file = (b: Browser, q = "") => b.req("GET", `/v1/projects/${pid}/artifacts/${a.id}/versions/${vid}/file${q}`);
    expect((await file(wang)).status).toBe(200);

    expect((await chen.json("PUT", `/v1/projects/${pid}/artifacts/${a.id}/access`, { visibility: "restricted", user_ids: [ids.zhou], request_id: rid() })).status).toBe(403);
    const set = await owner.json("PUT", `/v1/projects/${pid}/artifacts/${a.id}/access`, { visibility: "restricted", user_ids: [ids.zhou], request_id: rid() });
    expect(set.body.visibility).toBe("restricted");

    expect(await titles(wang, pid)).toEqual([]);
    expect(await eventKinds(wang, pid)).toEqual([]);
    expect((await wang.json("GET", `/v1/projects/${pid}/artifacts/${a.id}`)).status).toBe(404);
    expect((await file(wang)).status).toBe(404);
    for (const b of [zhou, chen, owner]) {
      expect(await titles(b, pid)).toEqual(["预算"]);
      expect((await file(b)).status).toBe(200);
    }
    expect(await eventKinds(zhou, pid)).toEqual(["artifact.published", "artifact.access_changed"]);

    // Only current members can be listed.
    const bad = await owner.json("PUT", `/v1/projects/${pid}/artifacts/${a.id}/access`, { visibility: "restricted", user_ids: ["usr_nobody"], request_id: rid() });
    expect(bad.status).toBe(400);
  });

  it("hide referenced titles in submissions from people who cannot read them", async () => {
    const { pid, owner, chen, wang, ids } = await team();
    const a = await draft(chen, pid);
    const pub = await publish(chen, pid, a);
    await owner.json("PUT", `/v1/projects/${pid}/artifacts/${a.id}/access`, { visibility: "restricted", user_ids: [ids.chen], request_id: rid() });
    const t = (await chen.json("POST", `/v1/projects/${pid}/tasks`, { title: "t", request_id: rid() })).body;
    await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
    const sub = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/submit`, { summary: "见方案", artifact_version_ids: [pub.versions[0].id], request_id: rid() });
    expect(sub.body.task.status).toBe("review");
    const forWang = (await wang.json("GET", `/v1/projects/${pid}/tasks/${t.id}`)).body.submissions[0].artifacts;
    expect(forWang).toEqual([{ version_id: pub.versions[0].id, artifact_id: null, title: null, version: null, readable: false }]);
    const forOwner = (await owner.json("GET", `/v1/projects/${pid}/tasks/${t.id}`)).body.submissions[0].artifacts;
    expect(forOwner[0]).toMatchObject({ title: "接口方案", version: 1, readable: true });
  });

  it("rejects submissions pointing at drafts or other projects", async () => {
    const { pid, chen } = await team();
    const a = await draft(chen, pid);
    const t = (await chen.json("POST", `/v1/projects/${pid}/tasks`, { title: "t", request_id: rid() })).body;
    await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
    const res = await chen.json("POST", `/v1/projects/${pid}/tasks/${t.id}/submit`, { summary: "x", artifact_version_ids: [a.versions[0].id], request_id: rid() });
    expect(res.status).toBe(400);
  });
});

describe("files", () => {
  it("serve only previewable types inline, sandboxed, and everything else as opaque downloads", async () => {
    const { pid, chen } = await team();
    const html = await chen.upload(`/v1/projects/${pid}/files`, "evil.html", new TextEncoder().encode("<script>alert(1)</script>"));
    expect(html.body).toMatchObject({ media_type: "application/octet-stream", previewable: false });
    const a = (await chen.json("POST", `/v1/projects/${pid}/artifacts`, { title: "html", kind: "file", file_id: html.body.id, request_id: rid() })).body;
    const vid = (await publish(chen, pid, a)).versions[0].id;
    const res = await chen.req("GET", `/v1/projects/${pid}/artifacts/${a.id}/versions/${vid}/file?inline=1`);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const png = await chen.upload(`/v1/projects/${pid}/files`, "图.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const b = (await chen.json("POST", `/v1/projects/${pid}/artifacts`, { title: "png", kind: "file", file_id: png.body.id, request_id: rid() })).body;
    const bvid = (await publish(chen, pid, b)).versions[0].id;
    const img = await chen.req("GET", `/v1/projects/${pid}/artifacts/${b.id}/versions/${bvid}/file?inline=1`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-disposition")).toContain("filename*=UTF-8''%E5%9B%BE.png");
    expect(img.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("rejects oversized uploads without leaving anything behind", async () => {
    const { env, pid, chen } = await team();
    const res = await chen.upload(`/v1/projects/${pid}/files`, "big.bin", new Uint8Array(MAX_FILE_BYTES + 1));
    expect(res.status).toBe(413);
    expect((env.ctx.db.prepare("SELECT COUNT(*) AS n FROM stored_files").get() as { n: number }).n).toBe(0);
  });

  it("does not let someone attach another person's upload", async () => {
    const { pid, chen, wang } = await team();
    const up = await chen.upload(`/v1/projects/${pid}/files`, "a.txt", new TextEncoder().encode("a"));
    const res = await wang.json("POST", `/v1/projects/${pid}/artifacts`, { title: "x", kind: "file", file_id: up.body.id, request_id: rid() });
    expect(res.status).toBe(400);
  });
});

describe("soft delete", () => {
  it("closes reading and downloads, keeps a record for admins and hides its events", async () => {
    const { pid, owner, chen, wang } = await team();
    const up = await chen.upload(`/v1/projects/${pid}/files`, "a.txt", new TextEncoder().encode("a"));
    const a = (await chen.json("POST", `/v1/projects/${pid}/artifacts`, { title: "将删除", kind: "file", file_id: up.body.id, request_id: rid() })).body;
    const vid = (await publish(chen, pid, a)).versions[0].id;
    expect((await wang.req("DELETE", `/v1/projects/${pid}/artifacts/${a.id}`)).status).toBe(403);
    expect((await chen.req("DELETE", `/v1/projects/${pid}/artifacts/${a.id}`)).status).toBe(204);
    expect(await titles(wang, pid)).toEqual([]);
    expect((await wang.req("GET", `/v1/projects/${pid}/artifacts/${a.id}/versions/${vid}/file`)).status).toBe(404);
    expect((await owner.req("GET", `/v1/projects/${pid}/artifacts/${a.id}/versions/${vid}/file`)).status).toBe(404);
    expect(await eventKinds(wang, pid)).toEqual([]);
    expect((await owner.json("GET", `/v1/projects/${pid}/artifacts?deleted=1`)).body.artifacts.map((x: any) => x.title)).toEqual(["将删除"]);
    expect((await chen.json("GET", `/v1/projects/${pid}/artifacts?deleted=1`)).status).toBe(403);
  });
});
