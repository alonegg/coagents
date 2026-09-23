import type { ArtifactView, MilestoneView, ProjectView, SessionView, TaskView } from "@coagents/contract";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, formatTime, requestId, STATUS_LABEL } from "../api.js";
import { useEventStream } from "../stream.js";

export function OverviewTab({ project, session, onChanged }: { project: ProjectView; session: SessionView; onChanged: () => void }) {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [milestones, setMilestones] = useState<MilestoneView[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string; description: string } | null>(null);
  const manager = (project.role === "owner" || project.role === "admin") && project.lifecycle === "active";
  const tz = session.user.timezone;

  const load = useCallback(async () => {
    try {
      setTasks((await api<{ tasks: TaskView[] }>("GET", `/projects/${project.id}/tasks`)).tasks);
      setMilestones((await api<{ milestones: MilestoneView[] }>("GET", `/projects/${project.id}/milestones`)).milestones);
      setArtifacts((await api<{ artifacts: ArtifactView[] }>("GET", `/projects/${project.id}/artifacts`)).artifacts.filter((a) => a.status === "published").slice(0, 5));
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, [project.id]);
  useEffect(() => void load(), [load]);
  useEventStream(`/v1/projects/${project.id}/stream`, "event", () => void load());

  async function save(body: Record<string, unknown>, path = `/projects/${project.id}`, method = "PATCH") {
    setError(null);
    try {
      await api(method, path, body);
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  const done = count("done");
  const blocked = tasks.filter((t) => t.status === "blocked");
  const review = tasks.filter((t) => t.status === "review");
  const overdue = tasks.filter((t) => t.overdue);

  return (
    <>
      {error && <p className="error">{error}</p>}
      <section className="panel">
        {editing ? (
          <div className="stack wide">
            <label>名称<input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label>目标与说明<textarea rows={5} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></label>
            <div className="row"><button onClick={() => save(editing)}>保存</button><button className="link" onClick={() => setEditing(null)}>取消</button></div>
          </div>
        ) : (
          <>
            <h3 className="first">目标</h3>
            <p className="pre">{project.description || <span className="muted">尚未填写项目目标。</span>}</p>
            {manager && <button className="link" onClick={() => setEditing({ name: project.name, description: project.description })}>编辑名称与目标</button>}
          </>
        )}
        <p>
          项目截止：{project.due_at ? formatTime(project.due_at, tz) : "未设置"}
          {manager && (
            <>
              {" "}<input type="date" aria-label="项目截止日期" onChange={(e) => e.target.value && save({ due_at: e.target.value, request_id: requestId() }, `/projects/${project.id}/due`, "PUT")} />
              {project.due_at && <button className="link" onClick={() => save({ due_at: null, request_id: requestId() }, `/projects/${project.id}/due`, "PUT")}>清除</button>}
            </>
          )}
        </p>
      </section>

      <div className="grid2">
        <section className="panel">
          <h3 className="first">任务分布</h3>
          <p>{tasks.length === 0 ? "暂无任务" : `已完成 ${done} / ${tasks.length}（只反映任务数量，不代表整体完成度或质量）`}</p>
          <ul className="plain inline">
            {(["todo", "in_progress", "blocked", "review", "done"] as const).map((s) => <li key={s}>{STATUS_LABEL[s]} <strong>{count(s)}</strong></li>)}
          </ul>
          {overdue.length > 0 && <p className="warn">逾期任务 {overdue.length} 项</p>}
        </section>
        <section className="panel">
          <h3 className="first">里程碑</h3>
          {milestones.length === 0 && <p className="muted">暂无里程碑。</p>}
          <ul className="plain">
            {milestones.map((m) => (
              <li key={m.id}>
                <a href={`#/projects/${project.id}/milestones`}>{m.title}</a> ·{" "}
                {m.state === "achieved" ? <span className="live">已达成</span> : m.overdue ? <span className="warn">已逾期</span> : "进行中"} ·{" "}
                {m.due_at ? formatTime(m.due_at, tz) : "无截止"} · {m.counts.total ? `${m.counts.done}/${m.counts.total}` : "暂无任务"}
              </li>
            ))}
          </ul>
        </section>
        <section className="panel">
          <h3 className="first">需要处理</h3>
          {blocked.length + review.length === 0 && <p className="muted">没有阻塞或待验收的任务。</p>}
          <ul className="plain">
            {blocked.map((t) => <li key={t.id}><span className="badge">阻塞</span> <a href={`#/projects/${project.id}/tasks/${t.id}`}>{t.title}</a></li>)}
            {review.map((t) => <li key={t.id}><span className="badge">待验收</span> <a href={`#/projects/${project.id}/tasks/${t.id}`}>{t.title}</a></li>)}
          </ul>
        </section>
        <section className="panel">
          <h3 className="first">最近成果</h3>
          {artifacts.length === 0 && <p className="muted">暂无已发布成果。</p>}
          <ul className="plain">
            {artifacts.map((a) => <li key={a.id}><a href={`#/projects/${project.id}/artifacts/${a.id}`}>{a.title}</a> · v{a.current_version} · {formatTime(a.updated_at, tz)}</li>)}
          </ul>
        </section>
      </div>
    </>
  );
}
