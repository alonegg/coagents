import type { SessionView } from "@coagents/contract";
import { MyAgentsPage } from "./pages/MyAgents.js";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, loadSession, setCsrf } from "./api.js";
import { NotificationBell } from "./Notifications.js";
import { VersionBanner } from "./VersionBanner.js";
import { go, useRoute } from "./router.js";
import { AccountPage } from "./pages/Account.js";
import { AdminPage } from "./pages/Admin.js";
import { ApplyPage } from "./pages/Apply.js";
import { DeviceCodePage } from "./pages/DeviceCode.js";
import { Landing } from "./pages/Landing.js";
import { DevicesPage } from "./pages/Devices.js";
import { InvitePage } from "./pages/Invite.js";
import { LoginPage } from "./pages/Login.js";
import { ProjectPage } from "./pages/Project.js";
import { ProjectsPage } from "./pages/Projects.js";

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<SessionView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    loadSession().then(setSession, (e: ApiError) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  const onSignedIn = (s: SessionView) => {
    setCsrf(s.csrf_token);
    setSession(s);
    if (route.name === "login" || route.name === "home" || route.name === "apply") go("/projects");
  };

  async function signOut() {
    await api("DELETE", "/session").catch(() => undefined);
    setSession(null);
    go("/");
  }

  if (error) return <main className="shell"><p className="error">{error}</p></main>;
  if (session === undefined) return <main className="shell"><p className="muted">加载中…</p></main>;

  // The invitation page handles its own sign-in/registration so the token survives the flow.
  if (route.name === "invite") return <InvitePage token={route.token} session={session} onSignedIn={onSignedIn} />;
  if (!session) {
    if (route.name === "apply") return <ApplyPage />;
    if (route.name === "home") return <Landing />;
    return <LoginPage onSignedIn={onSignedIn} />;
  }
  // A temporary password must be replaced before anything else.
  if (session.user.must_change_password) {
    return (
      <main className="shell narrow">
        <AccountPage session={session} onChanged={refresh} forced />
      </main>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <a href="#/projects" className="brand">CoAgents Hub</a>
        <nav>
          <NotificationBell timeZone={session.user.timezone} />
          {session.user.instance_role === "maintainer" && <a href="#/admin">后台</a>}
          <a href="#/agents">我的 Agent</a>
          <a href="#/devices">设备</a>
          <a href="#/account">账户</a>
          <span className="muted">{session.user.display_name}（{session.user.username}）</span>
          <button className="link" onClick={signOut}>退出</button>
        </nav>
      </header>
      <VersionBanner />
      <main>
        {(route.name === "projects" || route.name === "home" || route.name === "login" || route.name === "apply") && <ProjectsPage session={session} />}
        {route.name === "account" && <AccountPage session={session} onChanged={refresh} />}
        {route.name === "admin" && (session.user.instance_role === "maintainer" ? <AdminPage tab={route.tab} session={session} /> : <p className="muted">页面不存在。</p>)}
        {route.name === "project" && <ProjectPage route={route} session={session} />}
        {route.name === "devices" && <DevicesPage session={session} />}
        {route.name === "my-agents" && <MyAgentsPage session={session} />}
        {route.name === "device-code" && <DeviceCodePage code={route.code} session={session} />}
      </main>
    </div>
  );
}
