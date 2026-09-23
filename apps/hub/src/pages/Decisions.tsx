import type { ProjectView, SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatTime, requestId } from "../api.js";
import { canWrite } from "./Board.js";

interface Decision {
  id: string;
  body: string;
  supersedes_id: string | null;
  superseded_by: string | null;
  created_by_name: string;
  created_at: string;
}

export function DecisionsTab({ project, session }: { project: ProjectView; session: SessionView }) {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [history, setHistory] = useState(false);
  const [body, setBody] = useState("");
  const [replacing, setReplacing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ decisions: Decision[] }>("GET", `/projects/${project.id}/decisions${history ? "?history=1" : ""}`).then(
      (r) => setDecisions(r.decisions),
      (e: ApiError) => setError(e.message),
    );
  }, [project.id, history]);
  useEffect(load, [load]);

  async function publish(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("POST", `/projects/${project.id}/decisions`, { body, ...(replacing ? { supersedes_id: replacing } : {}), request_id: requestId() });
      setBody("");
      setReplacing(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      load();
    }
  }

  const tz = session.user.timezone;
  return (
    <>
      <label className="row"><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> 显示已被替代的历史决策</label>
      {decisions.length === 0 && <p className="muted">暂无决策。</p>}
      <ul className="plain">
        {decisions.map((d) => (
          <li key={d.id} className={d.superseded_by ? "superseded" : ""}>
            <p className="pre">{d.body}</p>
            <small className="muted">
              {d.created_by_name} · {formatTime(d.created_at, tz)}
              {d.superseded_by && " · 已被替代"}
              {d.supersedes_id && " · 替代了旧决策"}
            </small>
            {canWrite(project) && !d.superseded_by && (
              <button className="link" onClick={() => setReplacing(d.id)}>替代此决策</button>
            )}
          </li>
        ))}
      </ul>
      {canWrite(project) && (
        <form onSubmit={publish} className="stack">
          <h2>{replacing ? "替代决策" : "发布决策"}</h2>
          {replacing && <p className="muted">新决策会替代所选旧决策，旧决策保留在历史中。<button type="button" className="link" onClick={() => setReplacing(null)}>取消替代</button></p>}
          <textarea value={body} onChange={(e) => setBody(e.target.value)} required />
          {error && <p className="error">{error}</p>}
          <button>发布</button>
        </form>
      )}
    </>
  );
}
