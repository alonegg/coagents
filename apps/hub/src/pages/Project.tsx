import type { InvitationView, MemberView, ProjectView, SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatTime, ROLE_LABEL } from "../api.js";

type Transfer = { id: string; from_user_id: string; to_user_id: string; created_at: string } | null;

export function ProjectPage({ id, session }: { id: string; session: SessionView }) {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [invitations, setInvitations] = useState<InvitationView[]>([]);
  const [transfer, setTransfer] = useState<Transfer>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newLink, setNewLink] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState("contributor");
  const [inviteTarget, setInviteTarget] = useState("");

  const canManage = project?.role === "owner" || project?.role === "admin";

  const load = useCallback(async () => {
    try {
      const p = await api<ProjectView>("GET", `/projects/${id}`);
      setProject(p);
      setMembers((await api<{ members: MemberView[] }>("GET", `/projects/${id}/members`)).members);
      setTransfer((await api<{ transfer: Transfer }>("GET", `/projects/${id}/ownership-transfer`)).transfer);
      if (p.role === "owner" || p.role === "admin") {
        setInvitations((await api<{ invitations: InvitationView[] }>("GET", `/projects/${id}/invitations`)).invitations);
      }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? "项目不存在或你无权访问。" : (e as Error).message);
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function createInvite(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      const r = await api<{ url: string }>("POST", `/projects/${id}/invitations`, {
        role: inviteRole,
        ...(inviteTarget ? { target_username: inviteTarget } : {}),
      });
      setNewLink(r.url);
    });
  }

  if (error) return <p className="error">{error}</p>;
  if (!project) return <p className="muted">加载中…</p>;
  const tz = session.user.timezone;

  return (
    <>
      <p><a href="#/projects">← 我的项目</a></p>
      <h1>{project.name} <span className="badge">{ROLE_LABEL[project.role]}</span></h1>
      <p>{project.description || <span className="muted">暂无说明</span>}</p>
      <p className="muted">项目时区 {project.timezone} · 创建于 {formatTime(project.created_at, tz)}</p>
      {notice && <p className="notice">{notice}</p>}

      {transfer && transfer.to_user_id === session.user.id && (
        <section className="panel">
          <p>你被邀请成为本项目的 Owner。接受后原 Owner 将成为 Admin。</p>
          <button onClick={() => act(() => api("POST", `/projects/${id}/ownership-transfer/accept`), "你已成为 Owner")}>接受所有权</button>
        </section>
      )}

      <h2>成员</h2>
      <table>
        <thead><tr><th>成员</th><th>角色</th><th>加入时间</th>{canManage && <th>操作</th>}</tr></thead>
        <tbody>
          {members.map((m) => {
            const editable = canManage && m.role !== "owner" && m.user_id !== session.user.id;
            return (
              <tr key={m.user_id}>
                <td>{m.display_name}（{m.username}）</td>
                <td>
                  {editable ? (
                    <select
                      aria-label={`${m.username} 的角色`}
                      value={m.role}
                      onChange={(e) => act(() => api("PATCH", `/projects/${id}/members/${m.user_id}`, { role: e.target.value }), "角色已更新")}
                    >
                      <option value="admin">Admin</option>
                      <option value="contributor">Contributor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  ) : ROLE_LABEL[m.role]}
                </td>
                <td>{formatTime(m.joined_at, tz)}</td>
                {canManage && (
                  <td>
                    {editable && <button className="link danger" onClick={() => act(() => api("DELETE", `/projects/${id}/members/${m.user_id}`), "成员已移除")}>移除</button>}
                    {project.role === "owner" && m.role !== "owner" && !transfer && (
                      <button className="link" onClick={() => act(() => api("POST", `/projects/${id}/ownership-transfer`, { user_id: m.user_id }), "已发起所有权转移，等待对方接受")}>转移所有权</button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {transfer && project.role === "owner" && (
        <p className="muted">
          所有权转移等待对方接受。
          <button className="link" onClick={() => act(() => api("DELETE", `/projects/${id}/ownership-transfer`), "已取消转移")}>取消</button>
        </p>
      )}

      {canManage && (
        <>
          <h2>邀请</h2>
          <form onSubmit={createInvite} className="row">
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} aria-label="邀请角色">
              <option value="admin">Admin</option>
              <option value="contributor">Contributor</option>
              <option value="viewer">Viewer</option>
            </select>
            <input placeholder="限定用户名（可选）" value={inviteTarget} onChange={(e) => setInviteTarget(e.target.value.trim())} />
            <button>生成邀请链接</button>
          </form>
          {newLink && (
            <div className="panel">
              <p>邀请链接只显示这一次，请自行发送给对方：</p>
              <code className="copy">{newLink}</code>
              {!inviteTarget && <p className="muted">未限定用户名：持有此链接的任何人都可以用它申请加入。</p>}
            </div>
          )}
          <table>
            <thead><tr><th>角色</th><th>限定用户</th><th>状态</th><th>过期时间</th><th /></tr></thead>
            <tbody>
              {invitations.map((i) => (
                <tr key={i.id}>
                  <td>{ROLE_LABEL[i.role]}</td>
                  <td>{i.target_username ?? "任何持有者"}</td>
                  <td>{{ pending: "待接受", accepted: "已接受", revoked: "已撤销", expired: "已过期" }[i.state]}</td>
                  <td>{formatTime(i.expires_at, tz)}</td>
                  <td>{i.state === "pending" && <button className="link danger" onClick={() => act(() => api("DELETE", `/projects/${id}/invitations/${i.id}`), "邀请已撤销")}>撤销</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
