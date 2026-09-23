import type { InvitationPreview, SessionView } from "@coagents/contract";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatTime, ROLE_LABEL } from "../api.js";
import { go } from "../router.js";
import { LoginForm } from "./Login.js";

export function InvitePage({
  token,
  session,
  onSignedIn,
}: {
  token: string;
  session: SessionView | null;
  onSignedIn: (s: SessionView) => void;
}) {
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"register" | "login">("register");
  const [form, setForm] = useState({ username: "", display_name: "", password: "" });

  useEffect(() => {
    api<InvitationPreview>("GET", `/invitations/${token}`).then(setPreview, (e: ApiError) => setError(e.message));
  }, [token]);

  async function register(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      onSignedIn(await api<SessionView>("POST", `/invitations/${token}/register`, { ...form, timezone }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function accept() {
    setError(null);
    try {
      const r = await api<{ project_id: string }>("POST", `/invitations/${token}/accept`);
      go(`/projects/${r.project_id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const tz = session?.user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <main className="shell narrow">
      <h1>项目邀请</h1>
      {!preview && !error && <p className="muted">检查邀请…</p>}
      {error && <p className="error">{error}</p>}
      {preview && (
        <>
          <p>
            你被邀请以 <strong>{ROLE_LABEL[preview.role]}</strong> 身份加入项目 <strong>{preview.project_name}</strong>。
            {preview.target_username && <> 此邀请仅限用户 <code>{preview.target_username}</code>。</>}
          </p>
          <p className="muted">有效期至 {formatTime(preview.expires_at, tz)}</p>
          {session ? (
            <>
              <p>当前账户：{session.user.display_name}（{session.user.username}）</p>
              <button onClick={accept}>接受邀请并加入</button> <a href="#/projects">暂不加入</a>
            </>
          ) : mode === "register" ? (
            <>
              <form onSubmit={register} className="stack">
                <label>用户名<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.trim() })} autoComplete="username" required /></label>
                <label>显示名<input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required /></label>
                <label>密码（至少 10 位）<input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" minLength={10} required /></label>
                <button>注册账户</button>
              </form>
              <p className="muted">注册后仍需确认接受邀请才会加入项目。已有账户？<button className="link" onClick={() => setMode("login")}>登录</button></p>
            </>
          ) : (
            <>
              <LoginForm onSignedIn={onSignedIn} submitLabel="登录后继续" />
              <p className="muted"><button className="link" onClick={() => setMode("register")}>改为注册新账户</button></p>
            </>
          )}
        </>
      )}
    </main>
  );
}
