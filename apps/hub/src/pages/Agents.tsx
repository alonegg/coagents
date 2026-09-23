import type { AgentConnectionView, ProjectView, SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, formatTime } from "../api.js";

export function AgentsTab({ project, session }: { project: ProjectView; session: SessionView }) {
  const [agents, setAgents] = useState<AgentConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ agents: AgentConnectionView[] }>("GET", `/projects/${project.id}/agents`).then((r) => setAgents(r.agents), (e: ApiError) => setError(e.message));
  }, [project.id]);
  useEffect(load, [load]);

  async function revoke(a: AgentConnectionView) {
    try {
      await api("DELETE", `/projects/${project.id}/agents/${a.id}`);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  const tz = session.user.timezone;
  const manager = project.role === "owner" || project.role === "admin";
  return (
    <>
      <p className="muted">
        在自己的电脑上运行 <code>coagents login --server {location.origin} --project {project.id}</code>，然后在这里批准终端显示的确认码。
        {manager ? " 你可以看到并撤销本项目所有成员的连接。" : " 你只能看到自己的连接。"}
      </p>
      {error && <p className="error">{error}</p>}
      {agents?.length === 0 && <p className="muted">还没有 Agent 连接。</p>}
      {agents && agents.length > 0 && (
        <table>
          <thead><tr><th>连接</th><th>成员</th><th>权限</th><th>状态</th><th>最近活动</th><th /></tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>{a.label}</td>
                <td>{a.username}</td>
                <td>{a.scopes.includes("write") ? "读写" : "只读"}</td>
                <td>{a.verified_at ? "已验证" : "待验证（尚未发生真实调用）"}</td>
                <td>{a.last_seen_at ? formatTime(a.last_seen_at, tz) : "—"}</td>
                <td>{(manager || a.user_id === session.user.id) && <button className="link danger" onClick={() => revoke(a)}>撤销</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
