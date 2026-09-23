import type { ProjectView, SessionView, TaskStatus, TaskView } from "@coagents/contract";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatTime, requestId, STATUS_LABEL } from "../api.js";
import { go } from "../router.js";
import { TaskDetail } from "./TaskDetail.js";

const COLUMNS: TaskStatus[] = ["todo", "in_progress", "blocked", "review", "done"];

export function canWrite(project: ProjectView): boolean {
  return project.role !== "viewer" && project.lifecycle === "active";
}

export function BoardTab({ project, session, taskId }: { project: ProjectView; session: SessionView; taskId?: string | undefined }) {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [title, setTitle] = useState("");
  const [criteria, setCriteria] = useState("");

  const load = useCallback(async () => {
    try {
      setTasks((await api<{ tasks: TaskView[] }>("GET", `/projects/${project.id}/tasks`)).tasks);
      setSyncedAt(new Date());
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, [project.id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api("POST", `/projects/${project.id}/tasks`, { title, acceptance_criteria: criteria, request_id: requestId() });
      setTitle("");
      setCriteria("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const total = tasks?.length ?? 0;
  const done = tasks?.filter((t) => t.status === "done").length ?? 0;
  const tz = session.user.timezone;

  return (
    <>
      <p className="muted sync">
        {error ? <span className="error">连接中断：{error}</span> : null}
        {syncedAt && <> 上次同步 {formatTime(syncedAt.toISOString(), tz)}</>}
        {" · "}
        {total === 0 ? "暂无任务" : `已完成 ${done} / ${total}`}
        {" · "}
        <button className="link" onClick={() => void load()}>刷新</button>
      </p>
      {tasks === null && !error && <p className="muted">加载中…</p>}
      <div className="board">
        {COLUMNS.map((col) => {
          const items = tasks?.filter((t) => t.status === col) ?? [];
          return (
            <section key={col} className="column" aria-label={STATUS_LABEL[col]}>
              <h3>{STATUS_LABEL[col]} <span className="muted">{items.length}</span></h3>
              {items.map((t) => (
                <a key={t.id} href={`#/projects/${project.id}/tasks/${t.id}`} className={`task-card${t.id === taskId ? " selected" : ""}`}>
                  <strong>{t.title}</strong>
                  {t.holder && (
                    <small className={t.holder.lease_active ? "muted" : "warn"}>
                      {t.holder.kind === "client" ? "Agent" : "执行者"}：{t.holder.display_name}
                      {t.holder.lease_active ? "" : "（租约已过期）"}
                    </small>
                  )}
                </a>
              ))}
            </section>
          );
        })}
      </div>
      {taskId && (
        <TaskDetail
          project={project}
          session={session}
          taskId={taskId}
          onChanged={load}
          onClose={() => go(`/projects/${project.id}/board`)}
        />
      )}
      {canWrite(project) && (
        <>
          <h2>新建任务</h2>
          <form onSubmit={create} className="stack">
            <label>标题<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></label>
            <label>验收条件<textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} /></label>
            <button>创建任务</button>
          </form>
        </>
      )}
    </>
  );
}
