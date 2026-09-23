import type { SessionView } from "@coagents/contract";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api.js";

export function LoginForm({ onSignedIn, submitLabel = "登录" }: { onSignedIn: (s: SessionView) => void; submitLabel?: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api<SessionView>("POST", "/session", { username, password }));
    } catch (err) {
      const messages: Record<string, string> = {
        registration_pending: "你的注册申请还在等待管理员审批，通过后即可登录。",
        registration_rejected: "你的注册申请未通过，请联系管理员。",
        unauthenticated: "用户名或密码不正确。",
        rate_limited: "尝试次数过多，请 15 分钟后再试。",
      };
      setError(err instanceof ApiError ? (messages[err.code] ?? err.message) : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <label>用户名<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required /></label>
      <label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>{busy ? "登录中…" : submitLabel}</button>
    </form>
  );
}

export function LoginPage({ onSignedIn }: { onSignedIn: (s: SessionView) => void }) {
  return (
    <main className="shell narrow">
      <p><a href="#/">← CoAgents</a></p>
      <h1>登录 CoAgents Hub</h1>
      <LoginForm onSignedIn={onSignedIn} />
      <p className="muted">还没有账号？<a href="#/apply">申请账号</a>，或打开项目管理员发给你的邀请链接。忘记密码请联系实例管理员重置。</p>
    </main>
  );
}
