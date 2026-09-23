import type { SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, loadSession, setCsrf } from "./api.js";
import { go, useRoute } from "./router.js";
import { DeviceCodePage } from "./pages/DeviceCode.js";
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
  };

  async function signOut() {
    await api("DELETE", "/session").catch(() => undefined);
    setSession(null);
    go("/projects");
  }

  if (error) return <main className="shell"><p className="error">{error}</p></main>;
  if (session === undefined) return <main className="shell"><p className="muted">加载中…</p></main>;

  // The invitation page handles its own sign-in/registration so the token survives the flow.
  if (route.name === "invite") return <InvitePage token={route.token} session={session} onSignedIn={onSignedIn} />;
  if (!session) return <LoginPage onSignedIn={onSignedIn} />;

  return (
    <div className="shell">
      <header className="topbar">
        <a href="#/projects" className="brand">CoAgents Hub</a>
        <nav>
          <a href="#/devices">设备</a>
          <span className="muted">{session.user.display_name}（{session.user.username}）</span>
          <button className="link" onClick={signOut}>退出</button>
        </nav>
      </header>
      <main>
        {route.name === "projects" && <ProjectsPage session={session} />}
        {route.name === "project" && <ProjectPage route={route} session={session} />}
        {route.name === "devices" && <DevicesPage session={session} />}
        {route.name === "device-code" && <DeviceCodePage code={route.code} session={session} />}
      </main>
    </div>
  );
}
