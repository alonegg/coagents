import type { InstanceInfo } from "@coagents/contract";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api.js";

export function ApplyPage() {
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [form, setForm] = useState({ username: "", display_name: "", email: "", note: "", password: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<InstanceInfo>("GET", "/instance").then(setInfo, () => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { confirm: _c, ...body } = form;
      await api("POST", "/registrations", { ...body, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      setDone(true);
    } catch (err) {
      const messages: Record<string, string> = {
        username_taken: "这个用户名已被使用或正在审批中，换一个吧。",
        registration_closed: "本实例暂不开放注册。请向项目管理员索取邀请链接。",
        rate_limited: "提交过于频繁，请一小时后再试。",
      };
      setError(err instanceof ApiError ? (messages[err.code] ?? err.message) : String(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <main className="shell narrow">
      <p><a href="#/">← {info?.site_name ?? "CoAgents"}</a></p>
      <h1>申请账号</h1>
      {done ? (
        <section className="panel">
          <p>申请已提交。管理员审批通过后，你就可以用刚才设置的用户名和密码<a href="#/login">登录</a>。</p>
          <p className="muted">账号开通后还看不到任何项目：请项目负责人在 Hub 中邀请你加入。</p>
        </section>
      ) : info?.registration_mode === "closed" ? (
        <p className="notice">本实例暂不开放注册申请。请向项目管理员索取邀请链接。</p>
      ) : (
        <form onSubmit={submit} className="stack">
          <label>用户名（2–32 位小写字母、数字、_ . -）<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.trim().toLowerCase() })} autoComplete="username" required pattern="[a-z0-9][a-z0-9_.\-]{1,31}" /></label>
          <label>显示名<input value={form.display_name} onChange={set("display_name")} required maxLength={64} /></label>
          <label>邮箱（仅供管理员联系你，系统不发邮件）<input type="email" value={form.email} onChange={set("email")} required /></label>
          <label>申请说明（你是谁、要参与哪个团队或项目）<textarea value={form.note} onChange={set("note")} required maxLength={1000} /></label>
          <label>密码（至少 10 位）<input type="password" value={form.password} onChange={set("password")} autoComplete="new-password" minLength={10} required /></label>
          <label>确认密码<input type="password" value={form.confirm} onChange={set("confirm")} autoComplete="new-password" minLength={10} required /></label>
          {error && <p className="error">{error}</p>}
          <button disabled={busy}>{busy ? "提交中…" : "提交申请"}</button>
          <p className="muted">已经收到项目邀请链接？直接打开链接注册即可，无需等待审批。</p>
        </form>
      )}
    </main>
  );
}
