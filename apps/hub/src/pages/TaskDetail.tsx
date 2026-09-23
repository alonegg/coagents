import type { ProjectView, SessionView, TaskView } from "@coagents/contract";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, formatTime, requestId, STATUS_LABEL } from "../api.js";
import { canWrite } from "./Board.js";

interface Submission {
  id: string;
  summary: string;
  evidence: string | null;
  artifacts: { version_id: string; artifact_id: string | null; title: string | null; version: number | null; readable: boolean }[];
  created_at: string;
  outcome: "accepted" | "rejected" | null;
  review_note: string | null;
}

type Detail = TaskView & { submissions: Submission[] };

export function TaskDetail({
  project,
  session,
  taskId,
  onChanged,
  onClose,
}: {
  project: ProjectView;
  session: SessionView;
  taskId: string;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [task, setTask] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [evidence, setEvidence] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [published, setPublished] = useState<{ versionId: string; label: string }[]>([]);

  const base = `/projects/${project.id}/tasks/${taskId}`;
  const load = useCallback(() => {
    api<Detail>("GET", base).then(setTask, (e: ApiError) => setError(e.status === 404 ? "任务不存在或无权访问。" : e.message));
  }, [base]);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ artifacts: { id: string; title: string; status: string; current_version: number | null }[] }>("GET", `/projects/${project.id}/artifacts`).then(async (r) => {
      const out: { versionId: string; label: string }[] = [];
      for (const a of r.artifacts.filter((x) => x.status === "published")) {
        const d = await api<{ versions: { id: string; version: number | null }[] }>("GET", `/projects/${project.id}/artifacts/${a.id}`);
        const cur = d.versions.find((v) => v.version === a.current_version);
        if (cur) out.push({ versionId: cur.id, label: `${a.title} v${a.current_version}` });
      }
      setPublished(out);
    }, () => undefined);
  }, [project.id]);

  async function act(path: string, body: Record<string, unknown>) {
    setError(null);
    try {
      await api("POST", path, { ...body, request_id: requestId() });
      setText("");
      setEvidence("");
      setPicked([]);
      load();
      await onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === "version_conflict") setError("任务已被他人修改，已刷新；请确认后重新操作。你的输入已保留。");
      else setError(e instanceof ApiError ? e.message : String(e));
      load();
    }
  }

  if (!task) return <section className="panel">{error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>}</section>;

  const tz = session.user.timezone;
  const writable = canWrite(project);
  const reviewer = (project.role === "owner" || project.role === "admin") && project.lifecycle === "active";
  const mine = task.holder?.kind === "user" && task.holder.user_id === session.user.id && task.holder.device_id === session.device_id && task.holder.lease_active;
  const claimable = task.status === "todo" || task.status === "blocked" || (task.status === "in_progress" && !task.holder?.lease_active);
  const v = task.version;

  return (
    <section className="panel task-detail" aria-label="任务详情">
      <div className="row between">
        <h2 className="first">{task.title}</h2>
        <button className="link" onClick={onClose}>关闭</button>
      </div>
      <p>状态：<strong>{STATUS_LABEL[task.status]}</strong> · 版本 {task.version} · 更新于 {formatTime(task.updated_at, tz)}</p>
      <p>
        执行者：
        {task.holder
          ? <>{task.holder.display_name}（{task.holder.kind === "client" ? "Agent" : "人工"}），租约{task.holder.lease_active ? `至 ${formatTime(task.holder.lease_until, tz)}` : "已过期"}</>
          : "无"}
      </p>
      {task.description && <p>{task.description}</p>}
      <h3>验收条件</h3>
      <p className="pre">{task.acceptance_criteria || <span className="muted">未填写</span>}</p>
      {error && <p className="error">{error}</p>}

      {writable && (
        <div className="actions">
          {claimable && <button onClick={() => act(`${base}/claim`, {})}>认领</button>}
          {mine && (
            <>
              <label>说明 / 阻塞原因 / 完成摘要<textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
              <label>证据（验证结果、commit 等）<textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} /></label>
              {published.length > 0 && (
                <label>关联已发布成果（提交时绑定当前版本）
                  <select multiple value={picked} onChange={(e) => setPicked([...e.target.selectedOptions].map((o) => o.value))}>
                    {published.map((p) => <option key={p.versionId} value={p.versionId}>{p.label}</option>)}
                  </select>
                </label>
              )}
              <div className="row">
                <button onClick={() => act(`${base}/renew`, {})}>续租</button>
                <button onClick={() => act(`${base}/release`, text ? { note: text } : {})}>释放</button>
                <button disabled={!text} onClick={() => act(`/projects/${project.id}/blockers`, { task_id: task.id, body: text })}>报告阻塞</button>
                <button disabled={!text || (!evidence && picked.length === 0)} onClick={() => act(`${base}/submit`, { summary: text, ...(evidence ? { evidence } : {}), artifact_version_ids: picked })}>提交待验收</button>
              </div>
            </>
          )}
        </div>
      )}

      {reviewer && (
        <div className="actions">
          {(task.status === "review" || task.status === "done" || task.holder) && (
            <label>验收说明 / 原因<textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
          )}
          <div className="row">
            {task.status === "review" && (
              <>
                <button onClick={() => act(`${base}/accept`, { expected_version: v, ...(text ? { note: text } : {}) })}>接受</button>
                <button disabled={!text} onClick={() => act(`${base}/reject`, { expected_version: v, reason: text })}>退回</button>
              </>
            )}
            {task.status === "done" && <button disabled={!text} onClick={() => act(`${base}/reopen`, { expected_version: v, reason: text })}>重开</button>}
            {task.holder && !mine && <button disabled={!text} onClick={() => act(`${base}/terminate`, { expected_version: v, reason: text })}>终止租约</button>}
          </div>
        </div>
      )}

      {task.submissions.length > 0 && (
        <>
          <h3>提交记录</h3>
          <ul className="plain">
            {task.submissions.map((s) => (
              <li key={s.id}>
                <strong>{formatTime(s.created_at, tz)}</strong> · {s.outcome === "accepted" ? "已接受" : s.outcome === "rejected" ? "已退回" : "待验收"}
                <p className="pre">{s.summary}</p>
                {s.evidence && <p className="pre muted">证据：{s.evidence}</p>}
                {s.artifacts.length > 0 && (
                  <p>成果：{s.artifacts.map((a) => a.readable
                    ? <a key={a.version_id} href={`#/projects/${project.id}/artifacts/${a.artifact_id}`}>{a.title} v{a.version} </a>
                    : <span key={a.version_id} className="muted">（你无权查看的成果） </span>)}</p>
                )}
                {s.review_note && <p className="pre">验收说明：{s.review_note}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
