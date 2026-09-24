import type { ProjectView, SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, formatTime, ROLE_LABEL } from "../api.js";
import type { ProjectTab } from "../router.js";
import { ActivityTab } from "./Activity.js";
import { AgentsTab } from "./Agents.js";
import { ArtifactDetail } from "./ArtifactDetail.js";
import { ArtifactsTab } from "./Artifacts.js";
import { BoardTab } from "./Board.js";
import { DecisionsTab } from "./Decisions.js";
import { MembersTab } from "./Members.js";
import { MilestonesTab } from "./Milestones.js";
import { OverviewTab } from "./Overview.js";
import { SettingsTab } from "./Settings.js";

const TAB_LABEL: Record<ProjectTab, string> = { overview: "概览", board: "看板", milestones: "里程碑", artifacts: "成果", activity: "活动", decisions: "决策", agents: "Agent 连接", members: "成员与邀请", settings: "设置与审计" };

export function ProjectPage({ route, session }: { route: { id: string; tab: ProjectTab; taskId?: string; artifactId?: string }; session: SessionView }) {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<ProjectView>("GET", `/projects/${route.id}`).then(setProject, (e: ApiError) =>
      setError(e.status === 404 ? "项目不存在或你无权访问。" : e.message),
    );
  }, [route.id]);
  useEffect(load, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!project) return <p className="muted">加载中…</p>;

  return (
    <>
      <p><a href="#/projects">← 我的项目</a></p>
      <h1>{project.name} <span className="badge">{ROLE_LABEL[project.role]}</span></h1>
      <p>{project.description || <span className="muted">暂无说明</span>}</p>
      <p className="muted">
        项目时区 {project.timezone} · 最近更新 {formatTime(project.updated_at, session.user.timezone)}
        {project.due_at && <> · 项目截止 {formatTime(project.due_at, session.user.timezone)}{project.due_overdue && <span className="warn">（已逾期）</span>}</>}
      </p>
      <nav className="tabs" aria-label="项目页面">
        {(Object.keys(TAB_LABEL) as ProjectTab[]).map((t) => (
          <a key={t} href={`#/projects/${project.id}/${t}`} aria-current={route.tab === t ? "page" : undefined}>{TAB_LABEL[t]}</a>
        ))}
      </nav>
      {project.agents_paused_at && (
        <p className="notice warn">本项目的所有 Agent 已被暂停：它们只能读取，不能写入。Owner/Admin 可以在“设置与审计”中恢复。</p>
      )}
      {project.lifecycle === "archived" && (
        <p className="notice">项目已归档，所有内容只读。需要继续工作时，由 Owner/Admin 在“设置与审计”中恢复项目。</p>
      )}
      {route.tab === "overview" && <OverviewTab project={project} session={session} onChanged={load} />}
      {route.tab === "settings" && <SettingsTab project={project} session={session} onChanged={load} />}
      {route.tab === "board" && <BoardTab project={project} session={session} taskId={route.taskId} />}
      {route.tab === "milestones" && <MilestonesTab project={project} session={session} />}
      {route.tab === "artifacts" && (route.artifactId ? <ArtifactDetail project={project} session={session} artifactId={route.artifactId} /> : <ArtifactsTab project={project} session={session} />)}
      {route.tab === "activity" && <ActivityTab project={project} session={session} />}
      {route.tab === "decisions" && <DecisionsTab project={project} session={session} />}
      {route.tab === "agents" && <AgentsTab project={project} session={session} />}
      {route.tab === "members" && <MembersTab id={project.id} session={session} onChanged={load} />}
    </>
  );
}
