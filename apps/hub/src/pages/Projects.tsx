import type { ProjectView, SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatTime, ROLE_LABEL, STATUS_LABEL } from "../api.js";
import { go } from "../router.js";

interface Card extends ProjectView {
  summary: {
    task_counts: Record<string, number>;
    last_activity_at: string | null;
    recent_artifact: { id: string; title: string; updated_at: string } | null;
    next_milestone: { id: string; title: string; due_at: string | null; overdue: boolean } | null;
  };
}

interface Activity {
  seq: number;
  project_id: string;
  project_name: string;
  kind: string;
  display_name: string;
  actor_client_id: string | null;
  subject_type: string;
  subject_id: string;
  summary: string;
  created_at: string;
}

const KIND_FILTERS: [string, string][] = [["", "全部类型"], ["task.", "任务"], ["blocker.", "阻塞"], ["decision.", "决策"], ["handoff.", "交接"], ["artifact.", "成果"], ["milestone.", "里程碑"], ["member.", "成员"]];

export function ProjectsPage({ session }: { session: SessionView }) {
  const [projects, setProjects] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"activity" | "name">("activity");
  const [archived, setArchived] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [feed, setFeed] = useState<Activity[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [feedProject, setFeedProject] = useState("");
  const [feedKind, setFeedKind] = useState("");
  const tz = session.user.timezone;

  const load = useCallback(() => {
    const params = new URLSearchParams({ sort, ...(q ? { q } : {}), ...(archived ? { lifecycle: "archived" } : {}) });
    api<{ projects: Card[] }>("GET", `/projects?${params.toString()}`).then((r) => setProjects(r.projects), (e: ApiError) => setError(e.message));
  }, [q, sort, archived]);
  useEffect(load, [load]);

  const loadFeed = useCallback(async (before?: number) => {
    const params = new URLSearchParams({ limit: "30", ...(feedProject ? { project_id: feedProject } : {}), ...(feedKind ? { kind: feedKind } : {}), ...(before ? { before: String(before) } : {}) });
    const r = await api<{ events: Activity[]; next_before: number | null }>("GET", `/activity?${params.toString()}`);
    setFeed((prev) => (before ? [...prev, ...r.events] : r.events));
    setNextBefore(r.next_before);
  }, [feedProject, feedKind]);
  useEffect(() => void loadFeed().catch(() => undefined), [loadFeed]);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const p = await api<ProjectView>("POST", "/projects", { name, description });
      go(`/projects/${p.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <>
      <h1>我的项目</h1>
      <div className="row">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="按名称搜索" aria-label="按名称搜索项目" />
        <select value={sort} onChange={(e) => setSort(e.target.value as "activity" | "name")} aria-label="排序">
          <option value="activity">按最近活动</option>
          <option value="name">按名称</option>
        </select>
        <label className="row"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> 查看已归档</label>
      </div>
      {error && <p className="error">{error}</p>}
      {projects === null && !error && <p className="muted">加载中…</p>}
      {projects?.length === 0 && <p className="muted">{q || archived ? "没有符合条件的项目。" : "还没有项目。创建一个项目，或打开管理员发来的邀请链接加入。"}</p>}
      <ul className="cards">
        {projects?.map((p) => {
          const c = p.summary.task_counts;
          const total = Object.values(c).reduce((a, b) => a + b, 0);
          return (
            <li key={p.id}>
              <a href={`#/projects/${p.id}`} className="card">
                <strong>{p.name}</strong>
                <span className="badge">{ROLE_LABEL[p.role]}</span>
                {p.lifecycle === "archived" && <span className="badge">已归档</span>}
                <p className="muted clamp">{p.description || "暂无说明"}</p>
                <p className="small">
                  {total === 0 ? "暂无任务" : (["todo", "in_progress", "blocked", "review", "done"] as const).map((s) => `${STATUS_LABEL[s]} ${c[s]}`).join(" · ")}
                </p>
                {p.summary.next_milestone && (
                  <p className={`small ${p.summary.next_milestone.overdue ? "warn" : ""}`}>
                    下个里程碑：{p.summary.next_milestone.title}{p.summary.next_milestone.due_at ? `（${formatTime(p.summary.next_milestone.due_at, tz)}${p.summary.next_milestone.overdue ? "，已逾期" : ""}）` : ""}
                  </p>
                )}
                {p.summary.recent_artifact && <p className="small">最近成果：{p.summary.recent_artifact.title}</p>}
                <small className="muted">最近活动 {p.summary.last_activity_at ? formatTime(p.summary.last_activity_at, tz) : "无"}</small>
              </a>
            </li>
          );
        })}
      </ul>

      <h2>最近活动</h2>
      <div className="row">
        <select value={feedProject} onChange={(e) => setFeedProject(e.target.value)} aria-label="按项目筛选">
          <option value="">全部项目</option>
          {projects?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={feedKind} onChange={(e) => setFeedKind(e.target.value)} aria-label="按类型筛选">
          {KIND_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      {feed.length === 0 && <p className="muted">暂无活动。</p>}
      <ol className="timeline">
        {feed.map((e) => (
          <li key={e.seq}>
            <span className="muted">{formatTime(e.created_at, tz)}</span> <a href={`#/projects/${e.project_id}`}>{e.project_name}</a> · <strong>{e.display_name}</strong>
            {e.actor_client_id && <span className="badge">Agent</span>} {e.summary}
            {e.subject_type === "task" && <> · <a href={`#/projects/${e.project_id}/tasks/${e.subject_id}`}>查看</a></>}
            {e.subject_type === "artifact" && <> · <a href={`#/projects/${e.project_id}/artifacts/${e.subject_id}`}>查看</a></>}
          </li>
        ))}
      </ol>
      {nextBefore && <button className="link" onClick={() => void loadFeed(nextBefore)}>加载更早的活动</button>}

      <h2>创建项目</h2>
      <form onSubmit={create} className="stack">
        <label>名称<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
        <label>说明<textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} /></label>
        <button>创建</button>
      </form>
    </>
  );
}
