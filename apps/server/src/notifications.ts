import { wakeUser } from "./bus.js";
import { nowIso, type Actor, type AppContext } from "./context.js";
import { newId } from "./ids.js";

// In-app notifications for task assignment, blockers, submissions awaiting review, directed
// handoffs and permission changes. One per (recipient, event); never for the actor themself.
export function notifyForEvent(
  ctx: AppContext,
  projectId: string,
  seq: number,
  kind: string,
  actor: Actor,
  data: Record<string, unknown>,
): void {
  const recipients = new Set<string>();
  const managers = () =>
    (ctx.db.prepare("SELECT user_id FROM memberships WHERE project_id = ? AND role IN ('owner', 'admin')").all(projectId) as { user_id: string }[]).map((r) => r.user_id);
  switch (kind) {
    case "task.assigned":
      if (typeof data.assignee_id === "string") recipients.add(data.assignee_id);
      break;
    case "task.submitted":
      for (const id of managers()) recipients.add(id);
      break;
    case "blocker.reported":
      for (const id of managers()) recipients.add(id);
      if (typeof data.needs_from_user_id === "string") recipients.add(data.needs_from_user_id);
      break;
    // The submitter learns why their work came back (an agent reads it through get_task).
    case "task.rejected":
      if (typeof data.submitted_by_user === "string") recipients.add(data.submitted_by_user);
      break;
    case "task.help_requested":
      if (typeof data.user_id === "string") recipients.add(data.user_id);
      break;
    case "handoff.prepared":
    case "member.role_changed":
      if (typeof data.target_user_id === "string") recipients.add(data.target_user_id);
      break;
    default:
      return;
  }
  recipients.delete(actor.userId);
  const insert = ctx.db.prepare(
    `INSERT OR IGNORE INTO notifications (id, recipient_id, project_id, event_seq, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = nowIso(ctx);
  for (const r of recipients) {
    insert.run(newId("ntf"), r, projectId, seq, kind, now);
    wakeUser(r);
  }
}

export interface NotificationView {
  id: string;
  project_id: string;
  project_name: string;
  kind: string;
  event_seq: number;
  summary: string;
  subject_type: string;
  subject_id: string;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

// Re-authorized on every read: notifications of projects the user left are never returned.
export function listNotifications(ctx: AppContext, userId: string, opts: { unreadOnly: boolean; after?: string; limit: number }): NotificationView[] {
  return ctx.db
    .prepare(
      `SELECT n.id, n.project_id, p.name AS project_name, n.kind, n.event_seq, e.summary, e.subject_type, e.subject_id,
              n.created_at, n.delivered_at, n.read_at
       FROM notifications n
       JOIN memberships m ON m.project_id = n.project_id AND m.user_id = n.recipient_id
       JOIN projects p ON p.id = n.project_id
       JOIN events e ON e.seq = n.event_seq
       WHERE e.subject_type != 'artifact' AND n.recipient_id = ? ${opts.unreadOnly ? "AND n.read_at IS NULL" : ""} ${opts.after ? "AND n.id > ?" : ""}
       ORDER BY n.event_seq DESC LIMIT ?`,
    )
    .all(...[userId, ...(opts.after ? [opts.after] : []), opts.limit]) as NotificationView[];
}

export function unreadCount(ctx: AppContext, userId: string): number {
  return (
    ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications n JOIN memberships m ON m.project_id = n.project_id AND m.user_id = n.recipient_id
         WHERE n.recipient_id = ? AND n.read_at IS NULL`,
      )
      .get(userId) as { n: number }
  ).n;
}

export function markDelivered(ctx: AppContext, userId: string, ids: string[]): void {
  const stmt = ctx.db.prepare("UPDATE notifications SET delivered_at = ? WHERE id = ? AND recipient_id = ? AND delivered_at IS NULL");
  const now = nowIso(ctx);
  for (const id of ids) stmt.run(now, id, userId);
}

export function markRead(ctx: AppContext, userId: string, ids: string[] | "all"): number {
  const now = nowIso(ctx);
  if (ids === "all") {
    return ctx.db.prepare("UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL").run(now, userId).changes;
  }
  const stmt = ctx.db.prepare("UPDATE notifications SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ? AND recipient_id = ? AND read_at IS NULL");
  return ids.reduce((n, id) => n + stmt.run(now, now, id, userId).changes, 0);
}
