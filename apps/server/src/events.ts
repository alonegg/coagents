import type { EventPage, EventView } from "@coagents/contract";
import { nowIso, type Actor, type AppContext } from "./context.js";
import { newId } from "./ids.js";

export interface NewEvent {
  kind: string;
  subjectType: string;
  subjectId: string;
  summary: string;
  // Structured, non-secret payload. Never lease tokens or credentials.
  data?: Record<string, unknown>;
}

// Must run inside the transaction that performs the business change it records.
export function appendEvent(ctx: AppContext, projectId: string, actor: Actor, e: NewEvent): number {
  const now = nowIso(ctx);
  const res = ctx.db
    .prepare(
      `INSERT INTO events (id, project_id, kind, actor_user_id, actor_client_id, actor_device_id, subject_type, subject_id, summary, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId("evt"), projectId, e.kind, actor.userId, actor.clientId, actor.deviceId, e.subjectType, e.subjectId, e.summary, JSON.stringify(e.data ?? {}), now);
  ctx.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
  return Number(res.lastInsertRowid);
}

interface EventRow {
  seq: number;
  id: string;
  project_id: string;
  kind: string;
  actor_user_id: string;
  display_name: string;
  actor_client_id: string | null;
  actor_device_id: string | null;
  subject_type: string;
  subject_id: string;
  summary: string;
  data: string;
  created_at: string;
}

export const MAX_EVENT_PAGE = 200;

// Events with seq > cursor, ascending. Subject-level visibility filtering joins here once restricted
// artifacts exist (M5); every event type so far is visible to all project members.
export function listEvents(ctx: AppContext, projectId: string, cursor: number, limit: number): EventPage {
  const rows = ctx.db
    .prepare(
      `SELECT e.*, u.display_name FROM events e JOIN users u ON u.id = e.actor_user_id
       WHERE e.project_id = ? AND e.seq > ? ORDER BY e.seq LIMIT ?`,
    )
    .all(projectId, cursor, limit + 1) as EventRow[];
  const page = rows.slice(0, limit);
  return {
    events: page.map(toView),
    next_cursor: page.length ? page[page.length - 1]!.seq : cursor,
    has_more: rows.length > limit,
  };
}

function toView(r: EventRow): EventView {
  return {
    seq: r.seq,
    id: r.id,
    project_id: r.project_id,
    kind: r.kind,
    actor: { user_id: r.actor_user_id, display_name: r.display_name, client_id: r.actor_client_id, device_id: r.actor_device_id },
    subject_type: r.subject_type,
    subject_id: r.subject_id,
    summary: r.summary,
    data: JSON.parse(r.data) as Record<string, unknown>,
    created_at: r.created_at,
  };
}

// The cursor only moves forward, and only to a seq that exists in the project.
export function ackCursor(ctx: AppContext, consumer: { kind: "device" | "client"; id: string }, projectId: string, seq: number): number {
  const max = (ctx.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE project_id = ?").get(projectId) as { m: number }).m;
  const target = Math.min(seq, max);
  ctx.db
    .prepare(
      `INSERT INTO cursors (consumer_kind, consumer_id, project_id, last_seen_seq, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_kind, consumer_id, project_id)
       DO UPDATE SET last_seen_seq = MAX(last_seen_seq, excluded.last_seen_seq), updated_at = excluded.updated_at`,
    )
    .run(consumer.kind, consumer.id, projectId, target, nowIso(ctx));
  return readCursor(ctx, consumer, projectId);
}

export function readCursor(ctx: AppContext, consumer: { kind: "device" | "client"; id: string }, projectId: string): number {
  const row = ctx.db
    .prepare("SELECT last_seen_seq FROM cursors WHERE consumer_kind = ? AND consumer_id = ? AND project_id = ?")
    .get(consumer.kind, consumer.id, projectId) as { last_seen_seq: number } | undefined;
  return row?.last_seen_seq ?? 0;
}
