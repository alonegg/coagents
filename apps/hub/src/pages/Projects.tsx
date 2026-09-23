import type { ProjectView, SessionView } from "@coagents/contract";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatTime, ROLE_LABEL } from "../api.js";
import { go } from "../router.js";

export function ProjectsPage({ session }: { session: SessionView }) {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    api<{ projects: ProjectView[] }>("GET", "/projects").then(
      (r) => setProjects(r.projects),
      (e: ApiError) => setError(e.message),
    );
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const p = await api<ProjectView>("POST", "/projects", { name, description });
      go(`/projects/${p.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <>
      <h1>我的项目</h1>
      {error && <p className="error">{error}</p>}
      {projects === null && !error && <p className="muted">加载中…</p>}
      {projects?.length === 0 && <p className="muted">还没有项目。创建一个项目，或打开管理员发来的邀请链接加入。</p>}
      <ul className="cards">
        {projects?.map((p) => (
          <li key={p.id}>
            <a href={`#/projects/${p.id}`} className="card">
              <strong>{p.name}</strong>
              <span className="badge">{ROLE_LABEL[p.role]}</span>
              <p className="muted">{p.description || "暂无说明"}</p>
              <small className="muted">更新于 {formatTime(p.updated_at, session.user.timezone)}</small>
            </a>
          </li>
        ))}
      </ul>
      <h2>创建项目</h2>
      <form onSubmit={create} className="stack">
        <label>名称<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
        <label>说明<textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} /></label>
        <button>创建</button>
      </form>
    </>
  );
}
