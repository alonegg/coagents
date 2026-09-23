import type { EventPage, EventView, ProjectView, SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, formatTime } from "../api.js";

// Peer text is untrusted: rendered as plain text only, never as HTML or commands.
export function ActivityTab({ project, session }: { project: ProjectView; session: SessionView }) {
  const [events, setEvents] = useState<EventView[]>([]);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const pull = useCallback(async () => {
    try {
      let c = cursor;
      const fresh: EventView[] = [];
      for (;;) {
        const page = await api<EventPage>("GET", `/projects/${project.id}/events?cursor=${c}&limit=200`);
        fresh.push(...page.events);
        c = page.next_cursor;
        if (!page.has_more) break;
      }
      if (fresh.length) {
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...prev, ...fresh.filter((e) => !seen.has(e.id))];
        });
        setCursor(c);
      }
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, [project.id, cursor]);

  useEffect(() => {
    void pull();
    const t = setInterval(() => void pull(), 10_000);
    return () => clearInterval(t);
  }, [pull]);

  const tz = session.user.timezone;
  return (
    <>
      {error && <p className="error">连接中断：{error}</p>}
      {events.length === 0 && !error && <p className="muted">暂无活动。</p>}
      <ol className="timeline">
        {[...events].reverse().map((e) => (
          <li key={e.id}>
            <span className="muted">{formatTime(e.created_at, tz)}</span> <strong>{e.actor.display_name}</strong>
            {e.actor.client_id && <span className="badge">Agent</span>} {e.summary}
            {e.subject_type === "task" && <> · <a href={`#/projects/${project.id}/tasks/${e.subject_id}`}>查看任务</a></>}
            {typeof e.data.body === "string" && <p className="pre quote">{e.data.body}</p>}
            {typeof e.data.note === "string" && <p className="pre quote">{e.data.note}</p>}
          </li>
        ))}
      </ol>
    </>
  );
}
