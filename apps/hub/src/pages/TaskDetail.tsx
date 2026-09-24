import type { CriterionCoverage, EvidenceItem, ProjectView, SessionView, TaskView } from "@coagents/contract";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, BLOCKER_KIND_LABEL, COVERAGE_LABEL, EVIDENCE_KIND_LABEL, formatTime, requestId, STATUS_LABEL } from "../api.js";
import { TaskAi } from "../Ai.js";
import { canWrite } from "./Board.js";

interface Submission {
  id: string;
  summary: string;
  evidence: string | null;
  evidence_items: EvidenceItem[];
  coverage: CriterionCoverage[];
  author_kind: "human" | "agent";
  submitted_by_name: string;
  artifacts: { version_id: string; artifact_id: string | null; title: string | null; version: number | null; readable: boolean }[];
  created_at: string;
  outcome: "accepted" | "rejected" | null;
  reviewed_by_name: string | null;
  review_note: string | null;
}

// Per-criterion result a person records when submitting from the Hub.
type HumanCheck = { result: "" | "pass" | "fail" | "partial" | "not_applicable"; detail: string };

type Detail = TaskView & { submissions: Submission[] };

interface Handoff {
  id: string;
  state: "pending" | "accepted" | "cancelled";
  from: { display_name: string; holder_kind: string };
  target_user_id: string | null;
  summary: string;
  next_steps: string;
  next_step_items: string[];
  risks: string | null;
  git: { repo_identity: string; branch: string; commit: string } | null;
  last_check: { ok: boolean; reasons: string[]; warnings: string[]; checked_at: string } | null;
  created_at: string;
}

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
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [published, setPublished] = useState<{ versionId: string; label: string }[]>([]);
  const [checks, setChecks] = useState<Record<string, HumanCheck>>({});
  const [blockerKind, setBlockerKind] = useState("other");
  const [editing, setEditing] = useState<{ id?: string; text: string }[] | null>(null);
  const [aiRefresh, setAiRefresh] = useState(0);

  const base = `/projects/${project.id}/tasks/${taskId}`;
  const load = useCallback(() => {
    api<Detail>("GET", base).then(setTask, (e: ApiError) => setError(e.status === 404 ? "任务不存在或无权访问。" : e.message));
    api<{ handoffs: Handoff[] }>("GET", `/projects/${project.id}/handoffs?task_id=${taskId}`).then((r) => setHandoffs(r.handoffs), () => undefined);
  }, [base, project.id, taskId]);
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

  async function act(path: string, body: Record<string, unknown>, method = "POST") {
    setError(null);
    try {
      await api(method, path, { ...body, request_id: requestId() });
      setText("");
      setEvidence("");
      setPicked([]);
      setChecks({});
      setEditing(null);
      load();
      setAiRefresh((n) => n + 1);
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
  const criteria = task.criteria ?? [];
  const evidenceItems: EvidenceItem[] = criteria.flatMap((c) => {
    const ch = checks[c.id];
    return ch && ch.result ? [{ criterion_id: c.id, kind: "review" as const, result: ch.result, detail: ch.detail.trim() || "人工核查" }] : [];
  });
  const canSubmit = !!text && (!!evidence || picked.length > 0 || evidenceItems.length > 0);

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
      <p>
        截止：{task.due_at ? <>{formatTime(task.due_at, tz)}{task.overdue && <span className="warn">（已逾期，状态不会因此自动改变）</span>}</> : "未设置"}
        {writable && (
          <>
            {" "}<input type="date" aria-label="截止日期" onChange={(e) => e.target.value && act(`${base}/due`, { expected_version: v, due_at: e.target.value }, "PUT")} />
            {task.due_at && <button className="link" onClick={() => act(`${base}/due`, { expected_version: v, due_at: null }, "PUT")}>清除</button>}
            <small className="muted"> 按项目时区 {project.timezone} 当天结束计算</small>
          </>
        )}
      </p>
      {task.description && <p>{task.description}</p>}
      <h3>验收清单</h3>
      {editing ? (
        <div className="stack">
          {editing.map((c, i) => (
            <div key={c.id ?? `new-${i}`} className="criteria-edit">
              <span className="muted">{c.id ?? "新"}</span>
              <input value={c.text} maxLength={1000} aria-label="验收条目" onChange={(e) => setEditing(editing.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              <button className="link danger" onClick={() => setEditing(editing.filter((_, j) => j !== i))}>删除</button>
            </div>
          ))}
          <div className="row">
            <button className="link" onClick={() => setEditing([...editing, { text: "" }])}>添加一条</button>
            <button
              onClick={() =>
                act(base, { expected_version: v, criteria: editing.filter((c) => c.text.trim()).map((c) => (c.id ? { id: c.id, text: c.text } : { text: c.text })) }, "PATCH")
              }
            >保存清单</button>
            <button className="link" onClick={() => setEditing(null)}>取消</button>
          </div>
          <small className="muted">已有条目保留编号，证据按编号对应；删除的编号不会再被使用。</small>
        </div>
      ) : (
        <>
          {criteria.length > 0 ? (
            <ol className="checklist">{criteria.map((c) => <li key={c.id}><span className="muted">{c.id}</span> {c.text}</li>)}</ol>
          ) : (
            !task.acceptance_criteria && <p className="muted">未填写</p>
          )}
          {task.acceptance_criteria && <p className="pre">{task.acceptance_criteria}</p>}
          {writable && task.status !== "done" && <button className="link" onClick={() => setEditing(criteria.map((c) => ({ id: c.id, text: c.text })))}>编辑清单</button>}
        </>
      )}
      {error && <p className="error">{error}</p>}

      {writable && (
        <div className="actions">
          {claimable && <button onClick={() => act(`${base}/claim`, {})}>认领</button>}
          {mine && (
            <>
              <label>说明 / 阻塞原因 / 完成摘要<textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
              {criteria.length > 0 && (
                <fieldset className="stack">
                  <legend>逐条核对（提交时作为证据）</legend>
                  {criteria.map((c) => (
                    <div key={c.id} className="criteria-edit">
                      <span title={c.text}>{c.id}</span>
                      <select aria-label={`${c.id} 结果`} value={checks[c.id]?.result ?? ""} onChange={(e) => setChecks({ ...checks, [c.id]: { detail: checks[c.id]?.detail ?? "", result: e.target.value as HumanCheck["result"] } })}>
                        <option value="">未核对</option>
                        <option value="pass">通过</option>
                        <option value="fail">未通过</option>
                        <option value="partial">部分通过</option>
                        <option value="not_applicable">不适用</option>
                      </select>
                      <input placeholder={c.text} aria-label={`${c.id} 说明`} value={checks[c.id]?.detail ?? ""} onChange={(e) => setChecks({ ...checks, [c.id]: { result: checks[c.id]?.result ?? "", detail: e.target.value } })} />
                    </div>
                  ))}
                </fieldset>
              )}
              <label>其他证据（验证结果、commit 等）<textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} /></label>
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
                <select aria-label="阻塞类型" value={blockerKind} onChange={(e) => setBlockerKind(e.target.value)}>
                  {Object.entries(BLOCKER_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <button disabled={!text} onClick={() => act(`/projects/${project.id}/blockers`, { task_id: task.id, body: text, kind: blockerKind })}>报告阻塞</button>
                <button disabled={!canSubmit} onClick={() => act(`${base}/submit`, { summary: text, ...(evidence ? { evidence } : {}), evidence_items: evidenceItems, artifact_version_ids: picked })}>提交待验收</button>
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

      <TaskAi projectId={project.id} taskId={task.id} tz={tz} reviewer={reviewer && task.status === "review"} writable={writable} refresh={aiRefresh} onUseNote={setText}
        taskStatus={task.status}
        onUseCriteria={(texts) => setEditing([...criteria.map((c) => ({ id: c.id, text: c.text })), ...texts.map((text) => ({ text }))])}
        onAssign={(userId) => act(base, { expected_version: v, assignee_id: userId }, "PATCH")}
        onHelp={(userId, note) => act(`${base}/help-requests`, { user_id: userId, note })}
      />

      {handoffs.length > 0 && (
        <>
          <h3>交接记录</h3>
          <ul className="plain">
            {handoffs.map((h) => (
              <li key={h.id}>
                <strong>{formatTime(h.created_at, tz)}</strong> · {h.from.display_name}（{h.from.holder_kind === "client" ? "Agent" : "人工"}）·{" "}
                {{ pending: "待接手", accepted: "已接手", cancelled: "已取消" }[h.state]}
                <p className="pre">已完成：{h.summary}</p>
                {h.next_step_items?.length ? (
                  <>下一步：<ol className="checklist">{h.next_step_items.map((s, i) => <li key={i} className="pre">{s}</li>)}</ol></>
                ) : (
                  <p className="pre">下一步：{h.next_steps}</p>
                )}
                {h.risks && <p className="pre">风险：{h.risks}</p>}
                {h.git && <p className="muted">代码：{h.git.repo_identity} · {h.git.branch} @ <code>{h.git.commit.slice(0, 12)}</code>（发送方 Connector 上报；未提交的代码不会随交接传输）</p>}
                {h.last_check && (
                  <p className={h.last_check.ok ? "muted" : "error"}>
                    最近一次接手检查（{formatTime(h.last_check.checked_at, tz)}）：{h.last_check.ok ? "通过" : `未通过：${h.last_check.reasons.join("；")}`}
                    {h.last_check.warnings.length > 0 && ` 提示：${h.last_check.warnings.join("；")}`}
                  </p>
                )}
                {h.state === "pending" && h.git && <p className="muted">代码交接需在接收方工作副本所在设备，通过 Connector 的 accept_handoff 接手。</p>}
              </li>
            ))}
          </ul>
        </>
      )}

      {task.submissions.length > 0 && (
        <>
          <h3>提交记录</h3>
          <ul className="plain">
            {task.submissions.map((s) => (
              <li key={s.id}>
                <strong>{formatTime(s.created_at, tz)}</strong> · {s.submitted_by_name}
                {s.author_kind === "agent" && <span className="badge">Agent</span>} ·{" "}
                {s.outcome === "accepted" ? "已接受" : s.outcome === "rejected" ? "已退回" : "待验收"}
                <p className="pre">{s.summary}</p>
                {s.coverage?.length > 0 && (
                  <ul className="plain">
                    {s.coverage.map((c) => (
                      <li key={c.criterion_id}>
                        <span className={`cov cov-${c.status}`}>{COVERAGE_LABEL[c.status]}</span>
                        <span className="muted">{c.criterion_id}</span> {c.text}
                        {s.evidence_items
                          .filter((e) => e.criterion_id === c.criterion_id)
                          .map((e, i) => <p key={i} className="pre muted">{EVIDENCE_KIND_LABEL[e.kind]}{e.result ? `（${COVERAGE_LABEL[e.result]}）` : ""}{e.ref ? `：${e.ref}` : ""}{e.detail ? ` — ${e.detail}` : ""}</p>)}
                      </li>
                    ))}
                  </ul>
                )}
                {s.evidence_items?.filter((e) => !e.criterion_id).map((e, i) => (
                  <p key={i} className="pre muted">{EVIDENCE_KIND_LABEL[e.kind]}{e.result ? `（${COVERAGE_LABEL[e.result]}）` : ""}{e.ref ? `：${e.ref}` : ""}{e.detail ? ` — ${e.detail}` : ""}</p>
                ))}
                {s.evidence && <p className="pre muted">证据：{s.evidence}</p>}
                {s.artifacts.length > 0 && (
                  <p>成果：{s.artifacts.map((a) => a.readable
                    ? <a key={a.version_id} href={`#/projects/${project.id}/artifacts/${a.artifact_id}`}>{a.title} v{a.version} </a>
                    : <span key={a.version_id} className="muted">（你无权查看的成果） </span>)}</p>
                )}
                {s.review_note && <p className="pre">验收说明{s.reviewed_by_name ? `（${s.reviewed_by_name}）` : ""}：{s.review_note}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
