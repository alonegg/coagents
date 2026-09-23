// Compares FTS5 trigram with app-side CJK unigram+bigram segmentation on a small Chinese corpus.
// Run: node scripts/spikes/cjk-search.mjs   (from the repo root, after pnpm install)
import { createRequire } from "node:module";
const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const Database = require("better-sqlite3");

const docs = [
  "经过比较，我们决定采用 SQLite 作为本机状态数据库，不使用 PostgreSQL。",
  "登录页包含用户名、密码与错误提示；限流后提示稍后再试。",
  "本周完成了看板与实时通知，下周处理全文检索。",
  "年度预算需要财务审批，预算表见附件。",
  "接口返回 401 表示未登录，403 表示无权访问，429 表示请求过多。",
  "里程碑：可演示版本，截止日期为十月一日。",
];
// [query, index of the document that must be found]
const queries = [["库", 0], ["页", 1], ["登录", 1], ["预算", 3], ["通知", 2], ["数据库", 0], ["全文检索", 2], ["状态数据库", 0], ["无权访问", 4], ["截止日期", 5], ["sqlite", 0], ["429", 4]];

const CJK = /[\p{Script=Han}]+/gu;
const segment = (t) => t.replace(CJK, (run) => { const c = [...run]; return ` ${[...c.slice(0, -1).map((x, i) => x + c[i + 1]), ...c].join(" ")} `; });
const bigramQuery = (q) => { const parts = []; const rest = q.replace(CJK, (run) => { const c = [...run]; parts.push(`"${c.length === 1 ? run : c.slice(0, -1).map((x, i) => x + c[i + 1]).join(" ")}"`); return " "; }); for (const w of rest.split(/\W+/u).filter(Boolean)) parts.push(`"${w}"`); return parts.join(" AND "); };

const db = new Database(":memory:");
db.exec("CREATE VIRTUAL TABLE tri USING fts5(body, tokenize='trigram'); CREATE VIRTUAL TABLE bi USING fts5(body, tokenize='unicode61 remove_diacritics 2');");
docs.forEach((d, i) => { db.prepare("INSERT INTO tri(rowid, body) VALUES (?, ?)").run(i + 1, d); db.prepare("INSERT INTO bi(rowid, body) VALUES (?, ?)").run(i + 1, segment(d)); });

let tri = 0, bi = 0;
for (const [q, want] of queries) {
  const t = (() => { try { return db.prepare("SELECT rowid FROM tri WHERE tri MATCH ?").all(`"${q}"`).map((r) => r.rowid - 1); } catch { return []; } })();
  const b = db.prepare("SELECT rowid FROM bi WHERE bi MATCH ?").all(bigramQuery(q)).map((r) => r.rowid - 1);
  tri += t.includes(want); bi += b.includes(want);
  console.log(`${q.padEnd(8)} trigram:${t.includes(want) ? "hit " : "MISS"}  bigram:${b.includes(want) ? "hit " : "MISS"}  (other docs also matching: ${b.filter((x) => x !== want).length})`);
}
console.log(`recall: trigram ${tri}/${queries.length}, unigram+bigram ${bi}/${queries.length}`);
