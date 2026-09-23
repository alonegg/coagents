import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso, type AppContext } from "./context.js";
import { invalid } from "./http-error.js";
import { artifactReadable, type Viewer } from "./visibility.js";

// CJK text has no spaces, and FTS5's unicode61 tokenizer would treat a whole run as one token.
// Each CJK run is indexed as its single characters plus overlapping bigrams, so one-character,
// two-character and longer queries all match (the CJKAnalyzer approach). Other scripts pass through.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

export function segment(text: string): string {
  return text.replace(CJK, (run) => {
    const chars = [...run];
    const bigrams = chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
    return ` ${[...bigrams, ...chars].join(" ")} `;
  });
}

// Builds an FTS5 query: every term must match. A CJK run becomes the phrase of its bigrams (or the
// single character); other words become quoted tokens.
export function toFtsQuery(q: string): { fts: string; terms: string[] } {
  const terms: string[] = [];
  const parts: string[] = [];
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  let rest = q.normalize("NFKC").trim();
  if (!rest) throw invalid("Enter something to search for");
  rest = rest.replace(CJK, (run) => {
    const chars = [...run];
    terms.push(run);
    parts.push(chars.length === 1 ? quote(run) : quote(chars.slice(0, -1).map((c, i) => c + chars[i + 1]).join(" ")));
    return " ";
  });
  for (const w of rest.split(/[^\p{L}\p{N}_]+/u).filter(Boolean)) {
    terms.push(w);
    parts.push(quote(w));
  }
  if (!parts.length) throw invalid("Enter letters or numbers to search for");
  return { fts: parts.join(" AND "), terms };
}

// ---- indexing -------------------------------------------------------------------------------

const queue = new Set<string>();
let running: Promise<void> | null = null;

// Called inside the publish transaction: the row exists as "pending" at commit, extraction runs after.
export function enqueueIndex(ctx: AppContext, versionId: string): void {
  const v = ctx.db
    .prepare("SELECT v.id, v.artifact_id, v.version, a.project_id FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?")
    .get(versionId) as { id: string; artifact_id: string; version: number; project_id: string };
  ctx.db
    .prepare(
      `INSERT INTO search_docs (artifact_version_id, artifact_id, project_id, version, index_state, updated_at) VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (artifact_version_id) DO UPDATE SET index_state = 'pending', updated_at = excluded.updated_at`,
    )
    .run(v.id, v.artifact_id, v.project_id, v.version, nowIso(ctx));
  queue.add(versionId);
  setImmediate(() => void drainIndexQueue(ctx));
}

export function drainIndexQueue(ctx: AppContext): Promise<void> {
  running ??= (async () => {
    while (queue.size) {
      const id = queue.values().next().value as string;
      queue.delete(id);
      await indexVersion(ctx, id).catch((err: unknown) => {
        ctx.db.prepare("UPDATE search_docs SET index_state = 'failed', error = ?, updated_at = ? WHERE artifact_version_id = ?").run(String(err).slice(0, 500), nowIso(ctx), id);
      });
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

// On start: anything left pending by a restart is indexed again, and published versions that were
// never indexed (e.g. published before search existed) are added.
export function resumeIndexing(ctx: AppContext): void {
  const missing = ctx.db
    .prepare("SELECT v.id FROM artifact_versions v LEFT JOIN search_docs d ON d.artifact_version_id = v.id WHERE v.state = 'published' AND d.artifact_version_id IS NULL")
    .all() as { id: string }[];
  for (const { id } of missing) enqueueIndex(ctx, id);
  for (const r of ctx.db.prepare("SELECT artifact_version_id FROM search_docs WHERE index_state = 'pending'").all() as { artifact_version_id: string }[]) {
    queue.add(r.artifact_version_id);
  }
  if (queue.size) setImmediate(() => void drainIndexQueue(ctx));
}

async function extractPdf(bytes: Uint8Array): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return text as string[];
}

async function indexVersion(ctx: AppContext, versionId: string): Promise<void> {
  const v = ctx.db
    .prepare(
      `SELECT v.body, v.url, f.media_type, f.storage_key, a.title, a.summary
       FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id LEFT JOIN stored_files f ON f.id = v.file_id WHERE v.id = ?`,
    )
    .get(versionId) as { body: string | null; url: string | null; media_type: string | null; storage_key: string | null; title: string; summary: string } | undefined;
  if (!v) return;
  let text = "";
  let pages: number[] | null = null;
  let state: "ready" | "unsupported" = "ready";
  let error: string | null = null;
  // Text is NFKC-normalized like queries are: PDF fonts often map ideographs to compatibility
  // code points (e.g. Kangxi radical U+2F64 for 用), which would otherwise never match.
  if (v.body !== null) text = v.body.normalize("NFKC");
  else if (v.url !== null) {
    state = "unsupported";
    error = "外部链接的正文不抓取，只能按标题和摘要检索";
  } else if (v.media_type === "text/markdown" || v.media_type === "text/plain") {
    text = readFileSync(join(ctx.config.filesDir, v.storage_key!), "utf8").normalize("NFKC");
  } else if (v.media_type === "application/pdf") {
    const perPage = await extractPdf(new Uint8Array(readFileSync(join(ctx.config.filesDir, v.storage_key!))));
    pages = [];
    for (const p of perPage) {
      pages.push(text.length);
      text += `${p.normalize("NFKC")}\n`;
    }
    if (!text.trim()) {
      state = "unsupported";
      error = "PDF 没有可提取的文字层（例如扫描件），只能按标题和摘要检索";
    }
  } else {
    state = "unsupported";
    error = "此文件类型不提取正文，只能按标题和摘要检索";
  }
  ctx.db.transaction(() => {
    ctx.db.prepare("DELETE FROM search_fts WHERE artifact_version_id = ?").run(versionId);
    ctx.db.prepare("INSERT INTO search_fts (title, body, artifact_version_id) VALUES (?, ?, ?)").run(segment(`${v.title}\n${v.summary}`), segment(text), versionId);
    ctx.db
      .prepare("UPDATE search_docs SET index_state = ?, text = ?, pages = ?, error = ?, updated_at = ? WHERE artifact_version_id = ?")
      .run(state, text, pages ? JSON.stringify(pages) : null, error, nowIso(ctx), versionId);
  })();
}

// Titles live on the artifact; keep every indexed version's title field in step.
export function reindexTitle(ctx: AppContext, artifactId: string): void {
  const a = ctx.db.prepare("SELECT title, summary FROM artifacts WHERE id = ?").get(artifactId) as { title: string; summary: string };
  const stmt = ctx.db.prepare("UPDATE search_fts SET title = ? WHERE artifact_version_id = ?");
  for (const d of ctx.db.prepare("SELECT artifact_version_id FROM search_docs WHERE artifact_id = ?").all(artifactId) as { artifact_version_id: string }[]) {
    stmt.run(segment(`${a.title}\n${a.summary}`), d.artifact_version_id);
  }
}

// ---- querying -------------------------------------------------------------------------------

export interface SearchHit {
  artifact_id: string;
  artifact_version_id: string;
  title: string;
  version: number;
  is_current: boolean;
  index_state: string;
  matched_in: "body" | "title";
  snippet: string | null;
  location: { page?: number; line?: number } | null;
}

function locate(text: string, pages: number[] | null, terms: string[]): { snippet: string; location: SearchHit["location"] } | null {
  const lower = text.toLowerCase();
  let at = -1;
  let len = 0;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = t.length;
    }
  }
  if (at < 0) return null;
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + len + 60);
  const snippet = `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
  if (pages) {
    let page = 1;
    for (let i = 0; i < pages.length; i++) if (pages[i]! <= at) page = i + 1;
    return { snippet, location: { page } };
  }
  return { snippet, location: { line: text.slice(0, at).split("\n").length } };
}

// Permission filtering happens in the query itself, before counting or building snippets, so totals
// and snippets can never include artifacts the viewer may not read, whatever state the index is in.
export function searchArtifacts(
  ctx: AppContext,
  projectId: string,
  viewer: Viewer,
  q: string,
  opts: { scope: "current" | "all"; limit: number; offset: number },
): { total: number; hits: SearchHit[]; pending: number } {
  const { fts, terms } = toFtsQuery(q);
  const r = artifactReadable("a", viewer);
  const where = `search_fts MATCH ? AND d.project_id = ? AND a.status = 'published' AND (${r.sql}) ${opts.scope === "current" ? "AND d.version = a.current_version" : ""}`;
  const from = `FROM search_fts f JOIN search_docs d ON d.artifact_version_id = f.artifact_version_id JOIN artifacts a ON a.id = d.artifact_id`;
  const args = [fts, projectId, ...r.params];
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${where}`).get(...args) as { n: number }).n;
  const rows = ctx.db
    .prepare(
      `SELECT d.artifact_id, d.artifact_version_id, d.version, d.index_state, d.text, d.pages, a.title, a.current_version, bm25(search_fts, 2.0, 1.0) AS rank
       ${from} WHERE ${where} ORDER BY rank, d.version DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, opts.limit, opts.offset) as { artifact_id: string; artifact_version_id: string; version: number; index_state: string; text: string; pages: string | null; title: string; current_version: number }[];
  const pendingArgs = [projectId, ...r.params];
  const pending = (ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM search_docs d JOIN artifacts a ON a.id = d.artifact_id WHERE d.index_state = 'pending' AND d.project_id = ? AND a.status = 'published' AND (${r.sql})`)
    .get(...pendingArgs) as { n: number }).n;
  const hits = rows.map((row): SearchHit => {
    const found = locate(row.text, row.pages ? (JSON.parse(row.pages) as number[]) : null, terms);
    return {
      artifact_id: row.artifact_id,
      artifact_version_id: row.artifact_version_id,
      title: row.title,
      version: row.version,
      is_current: row.version === row.current_version,
      index_state: row.index_state,
      matched_in: found ? "body" : "title",
      snippet: found?.snippet ?? null,
      location: found?.location ?? null,
    };
  });
  return { total, hits, pending };
}
