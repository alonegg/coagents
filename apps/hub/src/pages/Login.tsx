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
      setError(err instanceof ApiError ? err.message : String(err));
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
      <h1>CoAgents Hub</h1>
      <p className="muted">使用团队账户登录。没有账户时，请向项目管理员索取邀请链接。</p>
      <LoginForm onSignedIn={onSignedIn} />
    </main>
  );
}
