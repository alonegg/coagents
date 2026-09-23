import type { ProjectRole, TaskStatus } from "@coagents/contract";
import { nowIso, type AppContext } from "./context.js";
import { artifactReadable, artifactReadableByMembership } from "./visibility.js";

export interface ProjectSummary {
  task_counts: Record<TaskStatus, number>;
  last_activity_at: string | null;
  recent_artifact: { id: string; title: string; updated_at: string } | null;
  next_milestone: { id: string; title: string; due_at: string | null; overdue: boolean } | null;
}

// Everything on a project card is computed from what this viewer may see: the last activity is the
// newest event they can read, the recent artifact the newest one they can read.
export function projectSummary(ctx: AppContext, projectId: string, userId: string, role: ProjectRole): ProjectSummary {
  const counts: Record<TaskStatus, number> = { todo: 0, in_progress: 0, blocked: 0, review: 0, done: 0 };
  for (const r of ctx.db.prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status").all(projectId) as { status: TaskStatus; n: number }[]) {
    counts[r.status] = r.n;
  }
  const ev = artifactReadable("a", { userId, role }, { includeDeleted: true });
  const last = ctx.db
    .prepare(
      `SELECT MAX(e.created_at) AS t FROM events e LEFT JOIN artifacts a ON e.subject_type = 'artifact' AND a.id = e.subject_id
       WHERE e.project_id = ? AND (e.subject_type != 'artifact' OR (${ev.sql}))`,
    )
    .get(projectId, ...ev.params) as { t: string | null };
  const ar = artifactReadable("a", { userId, role });
  const recent = ctx.db
    .prepare(`SELECT a.id, a.title, a.updated_at FROM artifacts a WHERE a.project_id = ? AND a.status = 'published' AND (${ar.sql}) ORDER BY a.updated_at DESC LIMIT 1`)
    .get(projectId, ...ar.params) as ProjectSummary["recent_artifact"] | undefined;
  const now = nowIso(ctx);
  const ms = ctx.db
    .prepare("SELECT id, title, due_at FROM milestones WHERE project_id = ? AND state = 'open' ORDER BY due_at IS NULL, due_at LIMIT 1")
    .get(projectId) as { id: string; title: string; due_at: string | null } | undefined;
  return {
    task_counts: counts,
    last_activity_at: last.t,
    recent_artifact: recent ?? null,
    next_milestone: ms ? { ...ms, overdue: ms.due_at !== null && ms.due_at < now } : null,
  };
}

export interface ActivityFilter {
  before?: number | undefined;
  projectId?: string | undefined;
  kind?: string | undefined;
  actorUserId?: string | undefined;
  limit: number;
}

// Cross-project activity: only projects the user is still a member of (not deleted), with the same
// per-project artifact visibility as everywhere else. Newest first, paged by seq.
export function crossProjectActivity(ctx: AppContext, userId: string, f: ActivityFilter): { events: unknown[]; next_before: number | null } {
  const vis = artifactReadableByMembership("a", "m", userId);
  const where = [
    "m.user_id = ?",
    "p.deleted_at IS NULL",
    `(e.subject_type != 'artifact' OR (${vis.sql}))`,
    ...(f.before ? ["e.seq < ?"] : []),
    ...(f.projectId ? ["e.project_id = ?"] : []),
    ...(f.kind ? ["e.kind LIKE ?"] : []),
    ...(f.actorUserId ? ["e.actor_user_id = ?"] : []),
  ];
  const args = [userId, ...vis.params, ...(f.before ? [f.before] : []), ...(f.projectId ? [f.projectId] : []), ...(f.kind ? [`${f.kind}%`] : []), ...(f.actorUserId ? [f.actorUserId] : [])];
  const rows = ctx.db
    .prepare(
      `SELECT e.seq, e.id, e.project_id, p.name AS project_name, e.kind, e.actor_user_id, u.display_name, e.actor_client_id, e.subject_type, e.subject_id, e.summary, e.created_at
       FROM events e JOIN memberships m ON m.project_id = e.project_id JOIN projects p ON p.id = e.project_id
       JOIN users u ON u.id = e.actor_user_id
       LEFT JOIN artifacts a ON e.subject_type = 'artifact' AND a.id = e.subject_id
       WHERE ${where.join(" AND ")} ORDER BY e.seq DESC LIMIT ?`,
    )
    .all(...args, f.limit + 1) as { seq: number }[];
  const page = rows.slice(0, f.limit);
  return { events: page, next_before: rows.length > f.limit ? page[page.length - 1]!.seq : null };
}
