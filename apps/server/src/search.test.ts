import { describe, expect, it } from "vitest";
import { drainIndexQueue, segment, toFtsQuery } from "./search.js";
import { seedUser, testEnv, type Browser, type TestEnv } from "./test-helpers.js";

let n = 0;
const rid = () => `req-srch-${++n}-${Math.random().toString(36).slice(2)}`;

// A one-page PDF with a text layer, built by hand so tests need no PDF tooling.
function pdfWith(lines: string[]): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? "0 -16 Td " : ""}(${l}) Tj`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

async function publishMd(b: Browser, pid: string, title: string, body: string) {
  const a = (await b.json("POST", `/v1/projects/${pid}/artifacts`, { title, kind: "markdown", body, request_id: rid() })).body;
  await b.json("POST", `/v1/projects/${pid}/artifacts/${a.id}/publish`, { expected_revision: 1, request_id: rid() });
  return a.id as string;
}

async function setup() {
  const env = testEnv();
  const owner = await seedUser(env, "lin");
  const pid = (await owner.json("POST", "/v1/projects", { name: "p" })).body.id as string;
  const ids: Record<string, string> = {};
  const people: Record<string, Browser> = {};
  for (const [name, role] of [["chen", "contributor"], ["zhou", "viewer"]] as const) {
    const b = await seedUser(env, name);
    const token = (await owner.json("POST", `/v1/projects/${pid}/invitations`, { role })).body.token;
    await b.json("POST", `/v1/invitations/${token}/accept`);
    people[name] = b;
    ids[name] = (await b.json("GET", "/v1/session")).body.user.id;
  }
  return { env, pid, owner, chen: people.chen!, zhou: people.zhou!, ids };
}

const search = async (b: Browser, pid: string, q: string, scope = "") =>
  (await b.json("GET", `/v1/projects/${pid}/search?q=${encodeURIComponent(q)}${scope ? `&scope=${scope}` : ""}`)).body;
const titles = (r: any) => r.hits.map((h: any) => h.title).sort();

describe("CJK segmentation", () => {
  it("indexes single characters and bigrams and queries runs as bigram phrases", () => {
    expect(segment("采用SQLite保存")).toBe(" 采用 采 用 SQLite 保存 保 存 ");
    expect(toFtsQuery("数据库 SQLite")).toEqual({ fts: '"数据 据库" AND "SQLite"', terms: ["数据库", "SQLite"] });
    expect(toFtsQuery("库").fts).toBe('"库"');
  });
});

describe("full-text search", () => {
  async function corpus(env: TestEnv, owner: Browser, pid: string) {
    await publishMd(owner, pid, "技术选型记录", "经过比较，我们决定采用 SQLite 作为本机状态数据库，不使用 PostgreSQL。");
    await publishMd(owner, pid, "登录页设计", "登录页包含用户名、密码与错误提示；限流后提示稍后再试。");
    await publishMd(owner, pid, "周报", "本周完成了看板与实时通知，下周处理全文检索。");
    await drainIndexQueue(env.ctx);
  }

  it("finds Chinese words of any length, mixed scripts and case-insensitive Latin terms", async () => {
    const { env, pid, owner, zhou } = await setup();
    await corpus(env, owner, pid);
    const cases: [string, string[]][] = [
      ["库", ["技术选型记录"]],
      ["登录", ["登录页设计"]],
      ["全文检索", ["周报"]],
      ["状态数据库", ["技术选型记录"]],
      ["sqlite", ["技术选型记录"]],
      ["采用 SQLite", ["技术选型记录"]],
      ["看板 通知", ["周报"]],
      ["页", ["登录页设计"]],
      ["不存在的词", []],
    ];
    for (const [q, expected] of cases) expect([q, titles(await search(zhou, pid, q))]).toEqual([q, expected]);
    const hit = (await search(zhou, pid, "限流")).hits[0];
    expect(hit).toMatchObject({ matched_in: "body", is_current: true, location: { line: 1 } });
    expect(hit.snippet).toContain("限流");
    expect((await search(zhou, pid, "技术选型")).hits[0].matched_in).toBe("title");
  });

  it("never returns drafts, restricted or deleted artifacts, in hits or totals, and applies changes at once", async () => {
    const { env, pid, owner, chen, zhou, ids } = await setup();
    const budget = await publishMd(owner, pid, "预算", "年度预算机密：三十万");
    const draft = (await chen.json("POST", `/v1/projects/${pid}/artifacts`, { title: "草稿", kind: "markdown", body: "机密草稿内容", request_id: rid() })).body;
    await drainIndexQueue(env.ctx);
    expect((await search(zhou, pid, "机密")).total).toBe(1);

    await owner.json("PUT", `/v1/projects/${pid}/artifacts/${budget}/access`, { visibility: "restricted", user_ids: [ids.chen], request_id: rid() });
    const hidden = await search(zhou, pid, "机密");
    expect(hidden).toMatchObject({ total: 0, hits: [] });
    expect(JSON.stringify(hidden)).not.toContain("三十万");
    expect((await search(chen, pid, "机密")).total).toBe(1);
    expect(draft.status).toBe("draft");

    await owner.req("DELETE", `/v1/projects/${pid}/artifacts/${budget}`);
    expect((await search(chen, pid, "机密")).total).toBe(0);
    expect((await search(owner, pid, "机密")).total).toBe(0);
  });

  it("searches the current version by default and history on request", async () => {
    const { env, pid, owner, zhou } = await setup();
    const id = await publishMd(owner, pid, "方案", "旧结论：使用 MySQL");
    await owner.json("PATCH", `/v1/projects/${pid}/artifacts/${id}/draft`, { expected_revision: 0, body: "新结论：使用 SQLite", request_id: rid() });
    await owner.json("POST", `/v1/projects/${pid}/artifacts/${id}/publish`, { expected_revision: 1, request_id: rid() });
    await drainIndexQueue(env.ctx);
    expect((await search(zhou, pid, "MySQL")).total).toBe(0);
    const old = await search(zhou, pid, "MySQL", "all");
    expect(old.hits[0]).toMatchObject({ version: 1, is_current: false });
  });

  it("extracts PDF text layers with page locations and marks what it cannot read", async () => {
    const { env, pid, owner, zhou } = await setup();
    const up = await owner.upload(`/v1/projects/${pid}/files`, "report.pdf", pdfWith(["Quarterly review", "Decision: adopt SQLite for local state"]));
    const pdf = (await owner.json("POST", `/v1/projects/${pid}/artifacts`, { title: "Q3 report", kind: "file", file_id: up.body.id, request_id: rid() })).body;
    await owner.json("POST", `/v1/projects/${pid}/artifacts/${pdf.id}/publish`, { expected_revision: 1, request_id: rid() });
    const zip = await owner.upload(`/v1/projects/${pid}/files`, "archive.zip", new Uint8Array([80, 75, 3, 4]));
    const z = (await owner.json("POST", `/v1/projects/${pid}/artifacts`, { title: "代码归档", summary: "旧版本源码", kind: "file", file_id: zip.body.id, request_id: rid() })).body;
    await owner.json("POST", `/v1/projects/${pid}/artifacts/${z.id}/publish`, { expected_revision: 1, request_id: rid() });
    expect((await search(zhou, pid, "adopt")).pending).toBeGreaterThanOrEqual(0);
    await drainIndexQueue(env.ctx);

    const hit = (await search(zhou, pid, "adopt sqlite")).hits[0];
    expect(hit).toMatchObject({ title: "Q3 report", index_state: "ready", location: { page: 1 } });
    const meta = (await search(zhou, pid, "源码")).hits[0];
    expect(meta).toMatchObject({ title: "代码归档", index_state: "unsupported", matched_in: "title" });
  });

  it("matches text whose ideographs came out of a PDF as compatibility characters", async () => {
    const { env, pid, owner, zhou } = await setup();
    // "沿⽤" and "引⼊" as extracted from a real Chrome-printed PDF (Kangxi radicals U+2F64, U+2F0A).
    await publishMd(owner, pid, "附录", "数据同步沿\u2F64蓝鲸协议，不引\u2F0A新的消息队列。");
    await drainIndexQueue(env.ctx);
    expect((await search(zhou, pid, "沿用")).total).toBe(1);
    expect((await search(zhou, pid, "引入")).total).toBe(1);
  });

  it("rejects empty queries", async () => {
    const { pid, zhou } = await setup();
    expect((await zhou.json("GET", `/v1/projects/${pid}/search?q=%20`)).status).toBe(400);
  });
});
