import type { ProjectView, SessionView } from "@coagents/contract";
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
