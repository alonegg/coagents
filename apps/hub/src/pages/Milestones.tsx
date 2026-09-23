import type { MilestoneView, ProjectView, SessionView, TaskView } from "@coagents/contract";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatTime, requestId, STATUS_LABEL } from "../api.js";

type Detail = MilestoneView & { task_ids: string[] };

export function MilestonesTab({ project, session }: { project: ProjectView; session: SessionView }) {
  const [items, setItems] = useState<MilestoneView[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [open, setOpen] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [criteria, setCriteria] = useState("");
  const [due, setDue] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [pick, setPick] = useState<string[]>([]);
  const manager = (project.role === "owner" || project.role === "admin") && project.lifecycle === "active";
  const tz = session.user.timezone;

  const load = useCallback(async () => {
    try {
      setItems((await api<{ milestones: MilestoneView[] }>("GET", `/projects/${project.id}/milestones`)).milestones);
      setTasks((await api<{ tasks: TaskView[] }>("GET", `/projects/${project.id}/tasks`)).tasks);
      if (open) setOpen(await api<Detail>("GET", `/projects/${project.id}/milestones/${open.id}`));
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, [project.id, open?.id]);
  useEffect(() => void load(), [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      setReason("");
      setNote("");
      setPick([]);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      await load();
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    await act(() => api("POST", `/projects/${project.id}/milestones`, { title, criteria, due_at: due || null, request_id: requestId() }));
    setTitle("");
    setCriteria("");
    setDue("");
  }

  const taskTitle = (id: string) => tasks.find((t) => t.id === id);
  const free = tasks.filter((t) => !t.milestone_id);

  return (
    <>
      {error && <p className="error">{error}</p>}
      {items.length === 0 && <p className="muted">暂无里程碑。</p>}
      <ul className="plain">
        {items.map((m) => {
          const c = m.counts;
          return (
            <li key={m.id} className="panel">
              <div className="row between">
                <strong>{m.title}</strong>
                <span className={m.state === "achieved" ? "live" : m.overdue ? "warn" : "muted"}>
                  {m.state === "achieved" ? `已达成（${formatTime(m.confirmed_at!, tz)}）` : m.overdue ? "已逾期，未达成" : "进行中"}
                </span>
              </div>
              <p className="muted">
                截止 {m.due_at ? `${formatTime(m.due_at, tz)}（你的时区 ${tz}）` : "未设置"} ·{" "}
                {c.total === 0 ? "暂无任务" : `已完成 ${c.done} / ${c.total} · 阻塞 ${c.blocked} · 待验收 ${c.review} · 逾期任务 ${c.overdue}`}
              </p>
              {m.criteria && <p className="pre">验收条件：{m.criteria}</p>}
              {m.confirm_note && <p className="pre">达成依据：{m.confirm_note}</p>}
              <button className="link" onClick={() => void api<Detail>("GET", `/projects/${project.id}/milestones/${m.id}`).then(setOpen)}>查看关联任务</button>
            </li>
          );
        })}
      </ul>

      {open && (
        <section className="panel">
          <div className="row between">
            <h3 className="first">{open.title}：关联任务</h3>
            <button className="link" onClick={() => setOpen(null)}>关闭</button>
          </div>
          <ul>
            {open.task_ids.map((id) => {
              const t = taskTitle(id);
              return (
                <li key={id}>
                  {manager && open.state === "open" && <input type="checkbox" aria-label="选择移出" checked={pick.includes(id)} onChange={(e) => setPick(e.target.checked ? [...pick, id] : pick.filter((x) => x !== id))} />}{" "}
                  <a href={`#/projects/${project.id}/tasks/${id}`}>{t?.title ?? id}</a> · {t ? STATUS_LABEL[t.status] : ""}
                </li>
              );
            })}
          </ul>
          {manager && open.state === "open" && (
            <div className="stack">
              {free.length > 0 && (
                <label>加入任务
                  <select multiple value={pick.filter((id) => free.some((t) => t.id === id))} onChange={(e) => setPick([...pick.filter((id) => !free.some((t) => t.id === id)), ...[...e.target.selectedOptions].map((o) => o.value)])}>
                    {free.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                  </select>
                </label>
              )}
              <label>范围调整原因（必填，会记录在活动中）<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              <button disabled={!reason || pick.length === 0} onClick={() => act(() => api("POST", `/projects/${project.id}/milestones/${open.id}/scope`, {
                expected_version: open.version,
                add_task_ids: pick.filter((id) => !open.task_ids.includes(id)),
                remove_task_ids: pick.filter((id) => open.task_ids.includes(id)),
                reason,
                request_id: requestId(),
              }))}>调整范围</button>
              <label>达成依据<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：演示通过，录屏见成果" /></label>
              <button disabled={!note} onClick={() => act(() => api("POST", `/projects/${project.id}/milestones/${open.id}/achieve`, { expected_version: open.version, note, request_id: requestId() }))}>确认达成</button>
              <p className="muted">到期或 Agent 在线都不会自动达成；仍有未完成任务时需先调整范围。</p>
            </div>
          )}
          {manager && open.state === "achieved" && (
            <div className="row">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="重开原因" />
              <button disabled={!note} onClick={() => act(() => api("POST", `/projects/${project.id}/milestones/${open.id}/reopen`, { expected_version: open.version, note, request_id: requestId() }))}>重开</button>
            </div>
          )}
        </section>
      )}

      {manager && (
        <>
          <h2>新建里程碑</h2>
          <form onSubmit={create} className="stack">
            <label>标题<input value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
            <label>验收条件<textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} /></label>
            <label>目标日期（按项目时区 {project.timezone} 当天结束）<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
            <button>创建</button>
          </form>
        </>
      )}
    </>
  );
}
