import type { ArtifactVersionView, ArtifactView, MemberView, ProjectView, SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, formatTime, requestId } from "../api.js";
import { renderMarkdown } from "../markdown.js";
import { go } from "../router.js";
import { ARTIFACT_STATUS, KIND_LABEL } from "./Artifacts.js";
import { canWrite } from "./Board.js";

type Detail = ArtifactView & { versions: ArtifactVersionView[]; restricted_to?: string[] };

function formatSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function FileView({ base, v }: { base: string; v: ArtifactVersionView }) {
  const f = v.file!;
  const href = `${base}/versions/${v.id}/file`;
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (f.previewable && f.media_type.startsWith("text/")) {
      fetch(`${href}?inline=1`, { credentials: "same-origin" }).then((r) => (r.ok ? r.text() : Promise.reject())).then(setText, () => setText(null));
    }
  }, [href, f.previewable, f.media_type]);
  return (
    <>
      <p>
        {f.filename} · {f.media_type} · {formatSize(f.size)} · <a href={href}>下载</a>
      </p>
      {f.previewable && f.media_type.startsWith("image/") && <img className="preview" src={`${href}?inline=1`} alt={f.filename} />}
      {f.previewable && f.media_type === "application/pdf" && <iframe className="preview pdf" src={`${href}?inline=1`} title={f.filename} />}
      {text !== null && (f.media_type === "text/markdown" ? <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} /> : <pre className="pre">{text}</pre>)}
      {!f.previewable && <p className="muted">此类型不在站内预览，请下载查看。</p>}
    </>
  );
}

export function ArtifactDetail({ project, session, artifactId }: { project: ProjectView; session: SessionView; artifactId: string }) {
  const [art, setArt] = useState<Detail | null>(null);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [access, setAccess] = useState<{ visibility: "project" | "restricted"; users: Set<string> } | null>(null);

  const base = `/v1/projects/${project.id}/artifacts/${artifactId}`;
  const manager = project.role === "owner" || project.role === "admin";

  const load = useCallback(async () => {
    try {
      const a = await api<Detail>("GET", `/projects/${project.id}/artifacts/${artifactId}`);
      setArt(a);
      setSelected((s) => (s && a.versions.some((v) => v.id === s) ? s : (a.versions.find((v) => v.state === "published") ?? a.versions[0])?.id ?? null));
      if (manager) {
        setMembers((await api<{ members: MemberView[] }>("GET", `/projects/${project.id}/members`)).members);
        setAccess({ visibility: a.visibility, users: new Set(a.restricted_to ?? []) });
      }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? "成果不存在或你无权查看。" : (e as Error).message);
    }
  }, [project.id, artifactId, manager]);
  useEffect(() => void load(), [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError && e.code === "version_conflict" ? "草稿已在别处修改，已重新加载；你的输入仍保留在编辑框中。" : e instanceof ApiError ? e.message : String(e));
      await load();
    }
  }

  if (!art) return error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>;
  const tz = session.user.timezone;
  const editable = canWrite(project) && (manager || art.author.id === session.user.id);
  const draft = art.versions.find((v) => v.state === "draft");
  const v = art.versions.find((x) => x.id === selected);

  return (
    <>
      <p><a href={`#/projects/${project.id}/artifacts`}>← 成果列表</a></p>
      <h2 className="first">{art.title} {art.visibility === "restricted" && <span className="badge">受限</span>}</h2>
      {art.summary && <p>{art.summary}</p>}
      <p className="muted">
        {KIND_LABEL[art.kind]} · {ARTIFACT_STATUS[art.status]}{art.current_version ? ` · 当前 v${art.current_version}` : ""} · 作者 {art.author.display_name} · 创建于 {formatTime(art.created_at, tz)}
        {art.task_id && <> · <a href={`#/projects/${project.id}/tasks/${art.task_id}`}>关联任务</a></>}
      </p>
      {art.imported_by && (
        <p className="muted">导入材料：原作者 {art.source_author ?? "未知"}，原始日期 {art.source_at ?? "未知"}；导入于 {formatTime(art.imported_at!, tz)}</p>
      )}
      <p className="muted">发布成果表示进入可见范围，不代表内容准确或任务已验收。</p>
      {error && <p className="error">{error}</p>}

      <div className="row">
        <label>版本
          <select value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
            {art.versions.map((x) => (
              <option key={x.id} value={x.id}>{x.state === "draft" ? `工作草稿（修订 ${x.revision}）` : `v${x.version} · ${formatTime(x.published_at!, tz)}`}</option>
            ))}
          </select>
        </label>
      </div>

      {v && (
        <section className="panel">
          {v.state === "draft" && <p className="muted">草稿仅作者和项目管理员可见。</p>}
          {v.body !== null && <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(v.body) }} />}
          {v.url !== null && (
            <p>外部链接（目标站点自行控制访问权限，CoAgents 不保存其内容）：<br /><a href={v.url} target="_blank" rel="noopener noreferrer nofollow">{v.url}</a></p>
          )}
          {v.file && <FileView base={base} v={v} />}
        </section>
      )}

      {editable && art.status !== "deleted" && art.kind !== "file" && (
        <section>
          <h3>编辑</h3>
          {editing === null ? (
            <button onClick={() => setEditing((draft ?? v)?.body ?? (draft ?? v)?.url ?? "")}>{draft ? "继续编辑草稿" : "基于当前版本新建草稿"}</button>
          ) : (
            <div className="stack wide">
              <textarea rows={10} value={editing} onChange={(e) => setEditing(e.target.value)} />
              <div className="row">
                <button onClick={() => act(async () => {
                  await api("PATCH", `/projects/${project.id}/artifacts/${art.id}/draft`, {
                    expected_revision: draft?.revision ?? 0,
                    ...(art.kind === "markdown" ? { body: editing } : { url: editing }),
                    request_id: requestId(),
                  });
                  setEditing(null);
                })}>保存草稿</button>
                <button className="link" onClick={() => setEditing(null)}>取消</button>
              </div>
            </div>
          )}
        </section>
      )}

      {editable && draft && art.status !== "deleted" && (
        <p><button onClick={() => act(() => api("POST", `/projects/${project.id}/artifacts/${art.id}/publish`, { expected_revision: draft.revision, request_id: requestId() }))}>
          发布为 v{(art.current_version ?? 0) + 1}
        </button></p>
      )}

      {manager && access && art.status !== "deleted" && (
        <section className="panel">
          <h3>可见范围</h3>
          <label className="row"><input type="radio" checked={access.visibility === "project"} onChange={() => setAccess({ ...access, visibility: "project" })} /> 项目全部成员</label>
          <label className="row"><input type="radio" checked={access.visibility === "restricted"} onChange={() => setAccess({ ...access, visibility: "restricted" })} /> 仅限以下成员（Owner/Admin 与作者始终可见）</label>
          {access.visibility === "restricted" && (
            <div className="stack">
              {members.filter((m) => m.role !== "owner" && m.role !== "admin" && m.user_id !== art.author.id).map((m) => (
                <label key={m.user_id} className="row">
                  <input type="checkbox" checked={access.users.has(m.user_id)} onChange={(e) => {
                    const users = new Set(access.users);
                    if (e.target.checked) users.add(m.user_id);
                    else users.delete(m.user_id);
                    setAccess({ ...access, users });
                  }} /> {m.display_name}（{m.username}）
                </label>
              ))}
            </div>
          )}
          <button onClick={() => act(() => api("PUT", `/projects/${project.id}/artifacts/${art.id}/access`, { visibility: access.visibility, user_ids: [...access.users], request_id: requestId() }))}>保存可见范围</button>
        </section>
      )}

      {editable && art.status !== "deleted" && (
        <p><button className="link danger" onClick={() => act(async () => {
          await api("DELETE", `/projects/${project.id}/artifacts/${art.id}`);
          go(`/projects/${project.id}/artifacts`);
        })}>删除成果</button> <span className="muted">删除后成员不能再阅读或下载，已下载的副本无法收回。</span></p>
      )}
    </>
  );
}
