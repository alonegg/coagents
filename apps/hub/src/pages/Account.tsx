import type { SessionView } from "@coagents/contract";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api.js";

export function AccountPage({ session, onChanged, forced = false }: { session: SessionView; onChanged: () => void; forced?: boolean }) {
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (form.next !== form.confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    try {
      await api("PUT", "/session/password", { current_password: form.current, new_password: form.next });
      setDone(true);
      setForm({ current: "", next: "", confirm: "" });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 403 ? "当前密码不正确" : err.message) : String(err));
    }
  }

  return (
    <>
      <h1>{forced ? "请先设置新密码" : "我的账户"}</h1>
      {forced && <p className="notice">你正在使用管理员发放的临时密码。设置新密码后才能继续使用。</p>}
      {!forced && (
        <p className="muted">
          {session.user.display_name}（{session.user.username}）· 时区 {session.user.timezone} · {session.user.instance_role === "maintainer" ? "实例维护者" : "成员"}
        </p>
      )}
      <h2>修改密码</h2>
      <form onSubmit={submit} className="stack">
        <label>{forced ? "临时密码" : "当前密码"}<input type="password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} autoComplete="current-password" required /></label>
        <label>新密码（至少 10 位）<input type="password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} autoComplete="new-password" minLength={10} required /></label>
        <label>确认新密码<input type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} autoComplete="new-password" minLength={10} required /></label>
        {error && <p className="error">{error}</p>}
        {done && <p className="notice">密码已更新，你在其他设备上的登录已退出。</p>}
        <button>更新密码</button>
      </form>
    </>
  );
}
