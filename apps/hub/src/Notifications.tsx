import { useCallback, useEffect, useState } from "react";
import { api, formatTime } from "./api.js";
import { useEventStream } from "./stream.js";

interface Notice {
  id: string;
  project_id: string;
  project_name: string;
  kind: string;
  summary: string;
  subject_type: string;
  subject_id: string;
  created_at: string;
  read_at: string | null;
  muted: boolean;
}

const KIND_LABEL: Record<string, string> = {
  "task.assigned": "任务指派",
  "task.submitted": "待验收",
  "blocker.reported": "阻塞",
  "task.help_requested": "请求协助",
  "handoff.prepared": "定向交接",
  "member.role_changed": "权限变化",
};

export function NotificationBell({ timeZone }: { timeZone: string }) {
  const [items, setItems] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    api<{ notifications: Notice[]; unread: number }>("GET", "/notifications").then((r) => {
      setItems(r.notifications);
      setUnread(r.unread);
    }, () => undefined);
  }, []);
  useEffect(load, [load]);
  useEventStream("/v1/notifications/stream", "notification", load);

  async function read(ids: string[] | "all") {
    const r = await api<{ unread: number }>("POST", "/notifications/read", { ids });
    setUnread(r.unread);
    load();
  }

  return (
    <div className="bell">
      <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>通知{unread > 0 && <span className="count">{unread}</span>}</button>
      {open && (
        <div className="popover" role="dialog" aria-label="通知">
          <div className="row between">
            <strong>通知</strong>
            {unread > 0 && <button className="link" onClick={() => read("all")}>全部标为已读</button>}
          </div>
          {items.length === 0 && <p className="muted">暂无通知。</p>}
          <ul className="plain">
            {items.filter((n) => !n.muted).map((n) => (
              <li key={n.id} className={n.read_at ? "muted" : ""}>
                <span className="badge">{KIND_LABEL[n.kind] ?? n.kind}</span> {n.project_name}：{n.summary}
                <br />
                <small>{formatTime(n.created_at, timeZone)}</small>{" "}
                {n.subject_type === "task" && (
                  <a href={`#/projects/${n.project_id}/tasks/${n.subject_id}`} onClick={() => { if (!n.read_at) void read([n.id]); setOpen(false); }}>查看</a>
                )}
                {!n.read_at && <button className="link" onClick={() => read([n.id])}>标为已读</button>}
              </li>
            ))}
          </ul>
          {items.some((n) => n.muted) && (
            <details>
              <summary className="muted">超出 Agent 打扰上限、未单独提醒的 {items.filter((n) => n.muted).length} 条</summary>
              <ul className="plain">
                {items.filter((n) => n.muted).map((n) => (
                  <li key={n.id} className="muted">
                    <span className="badge">{KIND_LABEL[n.kind] ?? n.kind}</span> {n.project_name}：{n.summary} <small>{formatTime(n.created_at, timeZone)}</small>{" "}
                    {n.subject_type === "task" && <a href={`#/projects/${n.project_id}/tasks/${n.subject_id}`} onClick={() => setOpen(false)}>查看</a>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
