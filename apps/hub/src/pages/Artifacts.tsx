import { MAX_FILE_BYTES, type ArtifactView, type ProjectView, type SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatTime, requestId } from "../api.js";
import { go } from "../router.js";
import { canWrite } from "./Board.js";

export const KIND_LABEL: Record<string, string> = { markdown: "Markdown", file: "文件", link: "外部链接" };
export const ARTIFACT_STATUS: Record<string, string> = { draft: "草稿", published: "已发布", deleted: "已删除" };

async function uploadFile(projectId: string, file: File): Promise<{ id: string }> {
  const csrf = (await api<{ csrf_token: string }>("GET", "/session")).csrf_token;
  const res = await fetch(`/v1/projects/${projectId}/files`, {
    method: "POST",
    headers: { "x-csrf-token": csrf, "x-filename": encodeURIComponent(file.name) },
    body: file,
    credentials: "same-origin",
  });
  const data = (await res.json()) as { id: string; error?: { message: string } };
  if (!res.ok) throw new ApiError(res.status, "upload", data.error?.message ?? `上传失败（HTTP ${res.status}）`);
  return data;
}

export function ArtifactsTab({ project, session }: { project: ProjectView; session: SessionView }) {
  const [items, setItems] = useState<ArtifactView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"markdown" | "link" | "file">("markdown");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sourceAuthor, setSourceAuthor] = useState("");
  const [sourceAt, setSourceAt] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ artifacts: ArtifactView[] }>("GET", `/projects/${project.id}/artifacts`).then((r) => setItems(r.artifacts), (e: ApiError) => setError(e.message));
  }, [project.id]);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (kind === "file" && file && file.size > MAX_FILE_BYTES) {
      setError(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 上限`);
      return;
    }
    setBusy(true);
    try {
      const content = kind === "markdown" ? { body } : kind === "link" ? { url } : { file_id: (await uploadFile(project.id, file!)).id };
      const art = await api<ArtifactView>("POST", `/projects/${project.id}/artifacts`, {
        title,
        kind,
        ...content,
        ...(sourceAuthor ? { source_author: sourceAuthor } : {}),
        ...(sourceAt ? { source_at: sourceAt } : {}),
        request_id: requestId(),
      });
      go(`/projects/${project.id}/artifacts/${art.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const tz = session.user.timezone;
  return (
    <>
      {error && <p className="error">{error}</p>}
      {items?.length === 0 && <p className="muted">还没有你能查看的成果。</p>}
      {items && items.length > 0 && (
        <table>
          <thead><tr><th>标题</th><th>类型</th><th>状态</th><th>作者 / 来源</th><th>更新</th></tr></thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td><a href={`#/projects/${project.id}/artifacts/${a.id}`}>{a.title}</a>{a.visibility === "restricted" && <span className="badge">受限</span>}</td>
                <td>{KIND_LABEL[a.kind]}</td>
                <td>{ARTIFACT_STATUS[a.status]}{a.current_version ? ` v${a.current_version}` : ""}{a.has_draft && a.status === "published" ? "（有草稿）" : ""}</td>
                <td>{a.author.display_name}{a.imported_by && <> · 原作者 {a.source_author ?? "未知"}</>}</td>
                <td>{formatTime(a.updated_at, tz)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canWrite(project) && (
        <>
          <h2>新建或导入成果</h2>
          <form onSubmit={create} className="stack">
            <label>类型
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="markdown">Markdown 正文</option>
                <option value="file">上传文件</option>
                <option value="link">外部链接</option>
              </select>
            </label>
            <label>标题<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></label>
            {kind === "markdown" && <label>正文<textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} required /></label>}
            {kind === "link" && <label>地址<input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" required /></label>}
            {kind === "file" && (
              <label>文件（不超过 {MAX_FILE_BYTES / 1024 / 1024} MB）<input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></label>
            )}
            <details>
              <summary>导入已有材料时填写来源（可选）</summary>
              <label>原始作者<input value={sourceAuthor} onChange={(e) => setSourceAuthor(e.target.value)} /></label>
              <label>原始日期<input type="date" value={sourceAt} onChange={(e) => setSourceAt(e.target.value)} /></label>
              <p className="muted">不知道的字段留空，系统显示"未知"，不会用导入时间代替。</p>
            </details>
            <p className="muted">新成果先保存为只有你和项目管理员可见的草稿，发布后项目成员才能看到。</p>
            <button disabled={busy}>{busy ? "保存中…" : "保存草稿"}</button>
          </form>
        </>
      )}
    </>
  );
}
