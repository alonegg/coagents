import type { ProjectView, SessionView } from "@coagents/contract";
import { HUMAN_ONLY } from "@coagents/contract";
import { ProjectAiSwitch } from "../Ai.js";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, formatTime } from "../api.js";
import { go } from "../router.js";

interface AuditRecord {
  id: string;
  action: string;
  object_type: string;
  object_id: string;
  detail: Record<string, unknown>;
  created_at: string;
  actor: string | null;
}

const ACTION_LABEL: Record<string, string> = {
  "project.create": "创建项目",
  "project.ai": "切换 AI 辅助",
  "project.agents_pause": "暂停所有 Agent",
  "project.agents_resume": "恢复所有 Agent",
  "project.interrupt_limit": "调整 Agent 打扰上限",
  "agent.pause": "暂停 Agent 连接",
  "agent.resume": "恢复 Agent 连接",
  "project.archive": "归档项目",
  "project.restore": "恢复项目",
  "project.delete": "删除项目",
  "member.role_change": "调整角色",
  "member.remove": "移除成员",
  "invitation.create": "创建邀请",
  "invitation.revoke": "撤销邀请",
  "invitation.accept": "接受邀请",
  "ownership.offer": "发起所有权转移",
  "ownership.accept": "接受所有权",
  "agent.connect": "授权 Agent",
  "agent.revoke": "撤销 Agent",
  "agent.self_revoke": "Agent 卸载撤销",
  "artifact.access": "调整成果可见范围",
  "artifact.delete": "删除成果",
};

export function SettingsTab({ project, session, onChanged }: { project: ProjectView; session: SessionView; onChanged: () => void }) {
  const [records, setRecords] = useState<AuditRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const manager = project.role === "owner" || project.role === "admin";

  const load = useCallback(() => {
    if (manager) api<{ records: AuditRecord[] }>("GET", `/projects/${project.id}/audit`).then((r) => setRecords(r.records), (e: ApiError) => setError(e.message));
  }, [project.id, manager]);
  useEffect(load, [load]);

  async function act(method: string, path: string, after?: () => void) {
    setError(null);
    try {
      await api(method, path);
      after ? after() : onChanged();
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (!manager) return <p className="muted">项目设置与审计记录仅 Owner 和 Admin 可见。</p>;
  const tz = session.user.timezone;
  return (
    <>
      {error && <p className="error">{error}</p>}
      <AgentPolicy project={project} onChanged={() => { onChanged(); load(); }} />
      <ProjectAiSwitch project={project} />
      <section className="panel">
        <h3 className="first">归档</h3>
        {project.lifecycle === "active" ? (
          <>
            <p className="muted">归档后项目从默认列表隐藏，所有任务、成果、决策和成员变更都变为只读，进行中的租约立即失效。</p>
            <button onClick={() => act("POST", `/projects/${project.id}/archive`)}>归档项目</button>
          </>
        ) : (
          <>
            <p className="muted">恢复后可以继续协作；此前移除的成员和撤销的凭证不会恢复。</p>
            <button onClick={() => act("POST", `/projects/${project.id}/restore`)}>恢复项目</button>
          </>
        )}
      </section>
      {project.role === "owner" && (
        <section className="panel">
          <h3 className="first">删除项目</h3>
          <p className="muted">删除与归档不同：项目对所有成员消失，所有 Agent 连接被撤销。首版为软删除，数据保留在服务端供实例维护者处理。输入项目名称确认：</p>
          <div className="row">
            <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={project.name} aria-label="输入项目名称确认删除" />
            <button className="danger" disabled={confirmName !== project.name} onClick={() => act("DELETE", `/projects/${project.id}`, () => go("/projects"))}>删除</button>
          </div>
        </section>
      )}
      <h3>审计记录</h3>
      <p className="muted">记录成员、授权、成果权限与项目状态的变更；不含凭证或正文。</p>
      {records && (
        <table>
          <thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>对象</th><th>详情</th></tr></thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td>{formatTime(r.created_at, tz)}</td>
                <td>{r.actor ?? "—"}</td>
                <td>{ACTION_LABEL[r.action] ?? r.action}</td>
                <td>{r.object_type} <code>{r.object_id.slice(0, 12)}</code></td>
                <td><code>{Object.keys(r.detail).length ? JSON.stringify(r.detail) : ""}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// The human side of the boundary for this project: pause all agents, and cap how often agents may
// interrupt one person per day. The table lists what only people can do anywhere in CoAgents.
function AgentPolicy({ project, onChanged }: { project: ProjectView; onChanged: () => void }) {
  const [limit, setLimit] = useState(project.agent_interrupt_limit);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const active = project.lifecycle === "active";
  async function put(body: Record<string, unknown>) {
    setError(null);
    setSaved(false);
    try {
      await api("PUT", `/projects/${project.id}/agent-policy`, body);
      setSaved(true);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }
  return (
    <section className="panel">
      <h3 className="first">人与 Agent 的边界</h3>
      <p>
        项目内 Agent：<strong>{project.agents_paused_at ? "已暂停（只读）" : "正常"}</strong>{" "}
        {active && <button className={project.agents_paused_at ? "link" : "link danger"} onClick={() => put({ agents_paused: !project.agents_paused_at })}>{project.agents_paused_at ? "恢复所有 Agent" : "暂停所有 Agent"}</button>}
      </p>
      <p className="muted">暂停后所有 Agent 只能读取；它们持有的任务租约无法续期，到期后可由他人认领。单个连接可在“Agent 连接”页暂停。</p>
      <label>
        每人每天最多接受 Agent 打扰的次数（求助、阻塞点名、定向交接、指派）
        <div className="row">
          <input type="number" min={0} max={1000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} disabled={!active} />
          <button className="link" disabled={!active || limit === project.agent_interrupt_limit} onClick={() => put({ interrupt_limit: limit })}>保存</button>
        </div>
      </label>
      <p className="muted">超出后，Agent 的求助会被拒绝并提示它换一种方式；其他通知照常记录，但不再弹出或计入未读。</p>
      {error && <p className="error">{error}</p>}
      {saved && <p className="notice">已保存。</p>}
      <details>
        <summary>哪些事只能由人来做</summary>
        <ul className="checklist">{Object.values(HUMAN_ONLY).map((t) => <li key={t}>{t}</li>)}</ul>
        <p className="muted">其余的执行与协调（认领、提交证据、交接、报告阻塞、发布决策和成果、创建任务、求助）Agent 都可以代表授权它的人完成，并记在这个人名下。</p>
      </details>
    </section>
  );
}
