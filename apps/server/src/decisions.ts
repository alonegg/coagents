import { nowIso, type Actor, type AppContext } from "./context.js";
import { appendEvent } from "./events.js";
import { HttpError, notFound } from "./http-error.js";
import { newId } from "./ids.js";
import { blockerData, type Blocker } from "./tasks.js";

export interface DecisionView {
  id: string;
  body: string;
  supersedes_id: string | null;
  superseded_by: string | null;
  created_by: string;
  created_by_name: string;
  // Whether a person or an agent published it. Both take effect the same way.
  created_by_kind: "human" | "agent";
  created_at: string;
  event_seq: number;
}

// Superseding is guarded by a unique index on supersedes_id: of two concurrent replacements of the
// same decision, exactly one succeeds and the other gets a conflict.
export function publishDecision(ctx: AppContext, projectId: string, actor: Actor, body: string, supersedesId?: string): DecisionView {
  if (supersedesId) {
    const old = ctx.db.prepare("SELECT 1 FROM decisions WHERE id = ? AND project_id = ?").get(supersedesId, projectId);
    if (!old) throw notFound();
  }
  const id = newId("dec");
  const seq = appendEvent(ctx, projectId, actor, {
    kind: supersedesId ? "decision.superseded" : "decision.published",
    subjectType: "decision",
    subjectId: id,
    summary: supersedesId ? "替代了一条项目决策" : "发布项目决策",
    data: { body, ...(supersedesId ? { supersedes_id: supersedesId } : {}) },
  });
  try {
    ctx.db
      .prepare("INSERT INTO decisions (id, project_id, event_seq, body, supersedes_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, projectId, seq, body, supersedesId ?? null, actor.userId, nowIso(ctx));
  } catch (err) {
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new HttpError(409, "decision_already_superseded", "That decision was already replaced; read the current decision first");
    }
    throw err;
  }
  return listDecisions(ctx, projectId, true).find((d) => d.id === id)!;
}

export function listDecisions(ctx: AppContext, projectId: string, includeHistory: boolean): DecisionView[] {
  const rows = ctx.db
    .prepare(
      `SELECT d.id, d.body, d.supersedes_id, n.id AS superseded_by, d.created_by, u.display_name AS created_by_name,
              CASE WHEN e.actor_client_id IS NULL THEN 'human' ELSE 'agent' END AS created_by_kind, d.created_at, d.event_seq
       FROM decisions d JOIN users u ON u.id = d.created_by JOIN events e ON e.seq = d.event_seq
       LEFT JOIN decisions n ON n.supersedes_id = d.id
       WHERE d.project_id = ? ORDER BY d.event_seq DESC`,
    )
    .all(projectId) as DecisionView[];
  return includeHistory ? rows : rows.filter((d) => d.superseded_by === null);
}

export function publishGeneralBlocker(ctx: AppContext, projectId: string, actor: Actor, blocker: Blocker): number {
  return appendEvent(ctx, projectId, actor, {
    kind: "blocker.reported",
    subjectType: "project",
    subjectId: projectId,
    summary: "报告项目阻塞",
    data: blockerData(ctx, projectId, blocker),
  });
}
