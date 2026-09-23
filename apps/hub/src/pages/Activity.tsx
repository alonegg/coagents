import type { EventPage, EventView, ProjectView, SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, formatTime } from "../api.js";
import { LIVE_LABEL, useEventStream } from "../stream.js";

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

  const live = useEventStream(`/v1/projects/${project.id}/stream`, "event", () => void pull());
  useEffect(() => {
    void pull();
    if (live === "live") return;
    const t = setInterval(() => void pull(), 30_000);
    return () => clearInterval(t);
  }, [pull, live]);

  const tz = session.user.timezone;
  return (
    <>
      <p className="muted sync"><span className={live === "live" ? "live" : "warn"}>{LIVE_LABEL[live]}</span></p>
      {error && <p className="error">加载失败：{error}</p>}
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
