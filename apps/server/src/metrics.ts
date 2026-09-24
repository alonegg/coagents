import { INTERRUPT_KINDS } from "@coagents/contract";
import type { AppContext } from "./context.js";

// Whether collaboration actually pays off, split by who did the work (person or agent).
// Counts only; no content. Used to judge the human/agent boundary, never to change it automatically.

type Kind = "human" | "agent";

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const hours = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3600_000;
const round = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
const kindOf = (clientId: string | null): Kind => (clientId ? "agent" : "human");

export interface ProjectMetrics {
  window_days: number;
  reviews: Record<Kind, { reviewed: number; accepted: number; acceptance_rate: number | null; median_wait_hours: number | null }>;
  first_pass: Record<Kind, { done: number; first_pass: number; rate: number | null }>;
  waiting_review: { count: number; oldest_hours: number | null };
  blocked: { episodes: number; median_hours: number | null; now: number };
  handoffs: { accepted: number; median_pickup_hours: number | null; pending: number };
  interruptions: { user_id: string; name: string; delivered: number; muted: number }[];
}

export function projectMetrics(ctx: AppContext, projectId: string, days: number): ProjectMetrics {
  const now = ctx.clock().toISOString();
  const since = new Date(ctx.clock().getTime() - days * 24 * 3600_000).toISOString();

  const reviewed = ctx.db
    .prepare(
      `SELECT s.submitted_by_client AS client, s.outcome, s.created_at, s.reviewed_at FROM task_submissions s JOIN tasks t ON t.id = s.task_id
       WHERE t.project_id = ? AND s.outcome IS NOT NULL AND s.reviewed_at > ?`,
    )
    .all(projectId, since) as { client: string | null; outcome: string; created_at: string; reviewed_at: string }[];
  const reviews = {} as ProjectMetrics["reviews"];
  for (const k of ["human", "agent"] as const) {
    const mine = reviewed.filter((r) => kindOf(r.client) === k);
    const accepted = mine.filter((r) => r.outcome === "accepted").length;
    reviews[k] = {
      reviewed: mine.length,
      accepted,
      acceptance_rate: mine.length ? round(accepted / mine.length) : null,
      median_wait_hours: round(median(mine.map((r) => hours(r.created_at, r.reviewed_at)))),
    };
  }

  // Tasks accepted in the window: first pass when the accepted submission was the task's only one.
  const done = ctx.db
    .prepare(
      `SELECT s.submitted_by_client AS client, (SELECT COUNT(*) FROM task_submissions x WHERE x.task_id = s.task_id AND x.created_at <= s.created_at) AS n
       FROM task_submissions s JOIN tasks t ON t.id = s.task_id
       WHERE t.project_id = ? AND s.outcome = 'accepted' AND s.reviewed_at > ?`,
    )
    .all(projectId, since) as { client: string | null; n: number }[];
  const first_pass = {} as ProjectMetrics["first_pass"];
  for (const k of ["human", "agent"] as const) {
    const mine = done.filter((d) => kindOf(d.client) === k);
    const fp = mine.filter((d) => d.n === 1).length;
    first_pass[k] = { done: mine.length, first_pass: fp, rate: mine.length ? round(fp / mine.length) : null };
  }

  const waiting = ctx.db
    .prepare(
      `SELECT MIN(s.created_at) AS oldest, COUNT(*) AS n FROM task_submissions s JOIN tasks t ON t.id = s.task_id
       WHERE t.project_id = ? AND s.outcome IS NULL AND t.status = 'review'`,
    )
    .get(projectId) as { oldest: string | null; n: number };

  // A blocked episode runs from the blocker until the task is next claimed (or until now).
  const blockers = ctx.db
    .prepare(
      `SELECT e.subject_id AS task_id, e.created_at,
              (SELECT MIN(x.created_at) FROM events x WHERE x.project_id = e.project_id AND x.subject_type = 'task' AND x.subject_id = e.subject_id
                 AND x.kind = 'task.claimed' AND x.seq > e.seq) AS ended_at
       FROM events e WHERE e.project_id = ? AND e.kind = 'blocker.reported' AND e.subject_type = 'task' AND e.created_at > ?`,
    )
    .all(projectId, since) as { task_id: string; created_at: string; ended_at: string | null }[];
  const blockedNow = (ctx.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status = 'blocked'").get(projectId) as { n: number }).n;

  const handoffs = ctx.db
    .prepare("SELECT created_at, accepted_at FROM handoffs WHERE project_id = ? AND state = 'accepted' AND accepted_at > ?")
    .all(projectId, since) as { created_at: string; accepted_at: string }[];
  const pendingHandoffs = (ctx.db.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE project_id = ? AND state = 'pending'").get(projectId) as { n: number }).n;

  const interruptions = ctx.db
    .prepare(
      `SELECT n.recipient_id AS user_id, u.display_name AS name, SUM(n.muted = 0) AS delivered, SUM(n.muted = 1) AS muted
       FROM notifications n JOIN events e ON e.seq = n.event_seq JOIN users u ON u.id = n.recipient_id
       JOIN memberships m ON m.project_id = n.project_id AND m.user_id = n.recipient_id
       WHERE n.project_id = ? AND e.actor_client_id IS NOT NULL AND n.kind IN (${INTERRUPT_KINDS.map(() => "?").join(", ")}) AND n.created_at > ?
       GROUP BY n.recipient_id ORDER BY delivered DESC`,
    )
    .all(projectId, ...INTERRUPT_KINDS, since) as ProjectMetrics["interruptions"];

  return {
    window_days: days,
    reviews,
    first_pass,
    waiting_review: { count: waiting.n, oldest_hours: waiting.oldest ? round(hours(waiting.oldest, now)) : null },
    blocked: { episodes: blockers.length, median_hours: round(median(blockers.map((b) => hours(b.created_at, b.ended_at ?? now)))), now: blockedNow },
    handoffs: { accepted: handoffs.length, median_pickup_hours: round(median(handoffs.map((h) => hours(h.created_at, h.accepted_at)))), pending: pendingHandoffs },
    interruptions,
  };
}
