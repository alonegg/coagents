import type { SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatTime } from "../api.js";
import type { AdminTab } from "../router.js";

const TABS: [AdminTab, string][] = [["overview", "运行状态"], ["registrations", "注册审批"], ["users", "用户"], ["projects", "项目"], ["settings", "实例设置"], ["audit", "审计"]];

function useLoad<T>(path: string): [T | null, string | null, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<T>("GET", path).then((d) => { setData(d); setError(null); }, (e: ApiError) => setError(e.message));
  }, [path]);
  useEffect(load, [load]);
  return [data, error, load];
}

async function run(fn: () => Promise<unknown>, setError: (e: string | null) => void, after: () => void) {
  setError(null);
  try {
    await fn();
    after();
  } catch (e) {
    setError(e instanceof ApiError ? e.message : String(e));
  }
}

export function AdminPage({ tab, session }: { tab: AdminTab; session: SessionView }) {
  return (
    <>
      <h1>实例后台</h1>
      <p className="muted">管理账户与实例。项目内容不在这里显示：维护者身份不自动获得项目的阅读权限。</p>
      <nav className="tabs" aria-label="后台页面">
        {TABS.map(([t, l]) => <a key={t} href={`#/admin/${t}`} aria-current={tab === t ? "page" : undefined}>{l}</a>)}
      </nav>
      {tab === "overview" && <Overview />}
      {tab === "registrations" && <Registrations tz={session.user.timezone} />}
      {tab === "users" && <Users tz={session.user.timezone} me={session.user.id} />}
      {tab === "projects" && <Projects tz={session.user.timezone} />}
      {tab === "settings" && <Settings />}
      {tab === "audit" && <Audit tz={session.user.timezone} />}
    </>
  );
}

interface OverviewData {
  version: string;
  build: string | null;
  schema_version: number;
  started_at: string;
  open_streams: number;
  users: Record<string, number>;
  pending_registrations: number;
  projects: Record<string, number>;
  tasks: number;
  events: number;
  artifacts: number;
  file_bytes: number;
  active_agents: number;
  search_index: Record<string, number>;
  last_backup_at: string | null;
}

function Overview() {
  const [d, error] = useLoad<OverviewData>("/admin/overview");
  if (error) return <p className="error">{error}</p>;
  if (!d) return <p className="muted">加载中…</p>;
  const mb = (d.file_bytes / 1024 / 1024).toFixed(1);
  const stat = (label: string, value: string | number, note?: string) => (
    <div className="panel"><small className="muted">{label}</small><p className="big">{value}</p>{note && <small className="muted">{note}</small>}</div>
  );
  return (
    <>
      {d.pending_registrations > 0 && <p className="notice">{d.pending_registrations} 个注册申请等待审批。<a href="#/admin/registrations">去处理</a></p>}
      <div className="grid4">
        {stat("活跃用户", d.users.active ?? 0, `已停用 ${d.users.disabled ?? 0}`)}
        {stat("项目", d.projects.active ?? 0, `归档 ${d.projects.archived ?? 0} · 已删除 ${d.projects.deleted ?? 0}`)}
        {stat("在线实时连接", d.open_streams, `有效 Agent 连接 ${d.active_agents}`)}
        {stat("最近备份", d.last_backup_at ? new Date(d.last_backup_at).toLocaleString("zh-CN") : "未发现", "见部署文档中的备份流程")}
        {stat("任务 / 事件", `${d.tasks} / ${d.events}`)}
        {stat("成果 / 文件", `${d.artifacts} / ${mb} MB`)}
        {stat("检索索引", Object.entries(d.search_index).map(([k, v]) => `${k} ${v}`).join(" · ") || "空")}
        {stat("版本", d.version, `构建 ${d.build ?? "本地"} · 结构 v${d.schema_version} · 启动于 ${new Date(d.started_at).toLocaleString("zh-CN")}`)}
      </div>
    </>
  );
}

interface Registration {
  id: string;
  username: string;
  display_name: string;
  email: string;
  note: string;
  timezone: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_by_username: string | null;
  decision_note: string | null;
}

function Registrations({ tz }: { tz: string }) {
  const [status, setStatus] = useState("pending");
  const [d, loadError, load] = useLoad<{ registrations: Registration[] }>(`/admin/registrations${status ? `?status=${status}` : ""}`);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <div className="row">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="按状态筛选">
          <option value="pending">待审批</option>
          <option value="approved">已批准</option>
          <option value="rejected">已拒绝</option>
          <option value="">全部</option>
        </select>
      </div>
      {(error || loadError) && <p className="error">{error ?? loadError}</p>}
      {d?.registrations.length === 0 && <p className="muted">没有记录。</p>}
      <ul className="plain">
        {d?.registrations.map((r) => (
          <li key={r.id} className="panel">
            <div className="row between"><strong>{r.display_name}（{r.username}）</strong><small className="muted">{formatTime(r.created_at, tz)}</small></div>
            <p>邮箱：{r.email} · 时区 {r.timezone}</p>
            <p className="pre quote">{r.note}</p>
            {r.status === "pending" ? (
              <div className="row">
                <input placeholder="备注（拒绝时必填）" value={notes[r.id] ?? ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
                <button onClick={() => run(() => api("POST", `/admin/registrations/${r.id}/approve`, notes[r.id] ? { note: notes[r.id] } : {}), setError, load)}>批准</button>
                <button className="link danger" disabled={!notes[r.id]} onClick={() => run(() => api("POST", `/admin/registrations/${r.id}/reject`, { note: notes[r.id] }), setError, load)}>拒绝</button>
              </div>
            ) : (
              <p className="muted">{r.status === "approved" ? "已批准" : "已拒绝"} · {r.decided_by_username} · {r.decided_at && formatTime(r.decided_at, tz)}{r.decision_note ? ` · ${r.decision_note}` : ""}</p>
            )}
          </li>
        ))}
      </ul>
      <p className="muted">批准后账号只能登录，看不到任何项目；由项目负责人邀请进入项目。</p>
    </>
  );
}

interface AdminUser {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  instance_role: string;
  auth_state: string;
  must_change_password: number;
  created_at: string;
  last_login_at: string | null;
  projects: number;
  devices: number;
}

function Users({ tz, me }: { tz: string; me: string }) {
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const [d, loadError, load] = useLoad<{ users: AdminUser[] }>(`/admin/users?q=${encodeURIComponent(q)}${state ? `&state=${state}` : ""}`);
  const [error, setError] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ username: string; password: string } | null>(null);
  return (
    <>
      <div className="row">
        <input type="search" placeholder="用户名、显示名或邮箱" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索用户" />
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="按状态筛选">
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="disabled">已停用</option>
        </select>
      </div>
      {(error || loadError) && <p className="error">{error ?? loadError}</p>}
      {temp && (
        <div className="panel">
          <p>{temp.username} 的临时密码（只显示这一次，请通过可信渠道告知本人；对方登录后必须修改）：</p>
          <code className="copy">{temp.password}</code>
          <button className="link" onClick={() => setTemp(null)}>我已记下</button>
        </div>
      )}
      <table>
        <thead><tr><th>用户</th><th>邮箱</th><th>身份</th><th>状态</th><th>项目 / 设备</th><th>最近登录</th><th>操作</th></tr></thead>
        <tbody>
          {d?.users.map((u) => (
            <tr key={u.id}>
              <td>{u.display_name}（{u.username}）</td>
              <td>{u.email ?? "—"}</td>
              <td>{u.instance_role === "maintainer" ? "维护者" : "成员"}</td>
              <td>{u.auth_state === "active" ? (u.must_change_password ? "待改密码" : "正常") : "已停用"}</td>
              <td>{u.projects} / {u.devices}</td>
              <td>{u.last_login_at ? formatTime(u.last_login_at, tz) : "—"}</td>
              <td>
                {u.id === me ? <span className="muted">当前账户</span> : (
                  <>
                    {u.auth_state === "active"
                      ? <button className="link danger" onClick={() => run(() => api("POST", `/admin/users/${u.id}/disable`), setError, load)}>停用</button>
                      : <button className="link" onClick={() => run(() => api("POST", `/admin/users/${u.id}/enable`), setError, load)}>启用</button>}
                    <button className="link" onClick={() => run(async () => {
                      const r = await api<{ temporary_password: string }>("POST", `/admin/users/${u.id}/reset-password`);
                      setTemp({ username: u.username, password: r.temporary_password });
                    }, setError, load)}>重置密码</button>
                    {u.auth_state === "active" && (
                      <button className="link" onClick={() => run(() => api("POST", `/admin/users/${u.id}/role`, { instance_role: u.instance_role === "maintainer" ? "member" : "maintainer" }), setError, load)}>
                        {u.instance_role === "maintainer" ? "取消维护者" : "设为维护者"}
                      </button>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">停用会立即结束该用户所有设备上的登录和 Agent 连接；项目数据保留。实例至少保留一名维护者。</p>
    </>
  );
}

interface AdminProject {
  id: string;
  name: string;
  lifecycle: string;
  deleted: number;
  owner_id: string | null;
  owner_username: string | null;
  owner_state: string | null;
  members: number;
  tasks: number;
  last_activity_at: string | null;
  created_at: string;
}

function Projects({ tz }: { tz: string }) {
  const [d, loadError, load] = useLoad<{ projects: AdminProject[] }>("/admin/projects");
  const [error, setError] = useState<string | null>(null);
  const [recover, setRecover] = useState<{ id: string; members: { id: string; username: string; auth_state: string; role: string }[] } | null>(null);
  const [target, setTarget] = useState("");
  return (
    <>
      {(error || loadError) && <p className="error">{error ?? loadError}</p>}
      <table>
        <thead><tr><th>项目</th><th>Owner</th><th>状态</th><th>成员</th><th>任务</th><th>最近活动</th><th /></tr></thead>
        <tbody>
          {d?.projects.map((p) => (
            <tr key={p.id} className={p.deleted ? "muted" : ""}>
              <td>{p.name}</td>
              <td>{p.owner_username ?? "—"}{p.owner_state === "disabled" && <span className="warn">（已停用）</span>}</td>
              <td>{p.deleted ? "已删除" : p.lifecycle === "archived" ? "已归档" : "活跃"}</td>
              <td>{p.members}</td>
              <td>{p.tasks}</td>
              <td>{p.last_activity_at ? formatTime(p.last_activity_at, tz) : "—"}</td>
              <td>
                {!p.deleted && p.owner_state === "disabled" && (
                  <button className="link" onClick={() => void api<{ members: { id: string; username: string; auth_state: string; role: string }[] }>("GET", `/admin/projects/${p.id}/members`).then((r) => setRecover({ id: p.id, members: r.members }))}>转移所有权</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {recover && (
        <section className="panel">
          <p>Owner 已停用。把所有权交给该项目的一位现有成员（原 Owner 降为 Admin）：</p>
          <div className="row">
            <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="新 Owner">
              <option value="">选择成员</option>
              {recover.members.filter((m) => m.auth_state === "active" && m.role !== "owner").map((m) => <option key={m.id} value={m.id}>{m.username}（{m.role}）</option>)}
            </select>
            <button disabled={!target} onClick={() => run(() => api("POST", `/admin/projects/${recover.id}/owner`, { user_id: target }), setError, () => { setRecover(null); load(); })}>确认转移</button>
            <button className="link" onClick={() => setRecover(null)}>取消</button>
          </div>
        </section>
      )}
      <p className="muted">这里只显示元数据；任务标题、成果和活动内容只有项目成员能看到。</p>
    </>
  );
}

function Settings() {
  const [d, loadError, load] = useLoad<{ registration_mode: string; site_name: string; announcement: string }>("/admin/settings");
  const [form, setForm] = useState<{ registration_mode: string; site_name: string; announcement: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (d) setForm(d); }, [d]);
  if (!form) return loadError ? <p className="error">{loadError}</p> : <p className="muted">加载中…</p>;
  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    await run(() => api("PUT", "/admin/settings", form), setError, () => { setSaved(true); load(); });
  }
  return (
    <form onSubmit={save} className="stack">
      <label>站点名称<input value={form.site_name} onChange={(e) => setForm({ ...form, site_name: e.target.value })} maxLength={60} required /></label>
      <label>注册方式
        <select value={form.registration_mode} onChange={(e) => setForm({ ...form, registration_mode: e.target.value })}>
          <option value="approval">开放申请，管理员审批后开通</option>
          <option value="closed">关闭申请，只能通过项目邀请注册</option>
        </select>
      </label>
      <label>落地页公告（可留空）<textarea value={form.announcement} onChange={(e) => setForm({ ...form, announcement: e.target.value })} maxLength={1000} /></label>
      {error && <p className="error">{error}</p>}
      {saved && <p className="notice">已保存。</p>}
      <button>保存</button>
    </form>
  );
}

const ACTIONS: Record<string, string> = {
  "registration.submit": "提交注册申请",
  "registration.approve": "批准注册",
  "registration.reject": "拒绝注册",
  "login.failed": "登录失败",
  "user.disable": "停用用户",
  "user.enable": "启用用户",
  "user.password_reset": "重置密码",
  "user.password_change": "修改密码",
  "user.role": "调整实例身份",
  "user.register": "通过邀请注册",
  "device.revoke": "撤销设备",
  "instance.settings": "修改实例设置",
  "ownership.recover": "协助转移所有权",
};

function Audit({ tz }: { tz: string }) {
  const [d, error] = useLoad<{ records: { id: string; action: string; object_type: string; object_id: string; detail: Record<string, unknown>; created_at: string; actor: string | null }[] }>("/admin/audit");
  if (error) return <p className="error">{error}</p>;
  return (
    <table>
      <thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>对象</th><th>详情</th></tr></thead>
      <tbody>
        {d?.records.map((r) => (
          <tr key={r.id}>
            <td>{formatTime(r.created_at, tz)}</td>
            <td>{r.actor ?? "—"}</td>
            <td>{ACTIONS[r.action] ?? r.action}</td>
            <td>{r.object_type} <code>{r.object_id.slice(0, 14)}</code></td>
            <td><code>{Object.keys(r.detail).length ? JSON.stringify(r.detail) : ""}</code></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
