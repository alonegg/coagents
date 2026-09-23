import { resolveDue, type MilestoneView } from "@coagents/contract";
import { nowIso, type Actor, type AppContext } from "./context.js";
import { appendEvent } from "./events.js";
import { HttpError, invalid, notFound } from "./http-error.js";
import { newId } from "./ids.js";
import { loadRow } from "./tasks.js";

interface Row {
  id: string;
  project_id: string;
  title: string;
  criteria: string;
  due_at: string | null;
  state: "open" | "achieved";
  confirmed_by: string | null;
  confirmed_at: string | null;
  confirm_note: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const conflict = () => new HttpError(409, "version_conflict", "The milestone was changed by someone else; refresh and try again");

function projectZone(ctx: AppContext, projectId: string): string {
  return (ctx.db.prepare("SELECT timezone FROM projects WHERE id = ?").get(projectId) as { timezone: string }).timezone;
}

function view(ctx: AppContext, r: Row): MilestoneView {
  const now = nowIso(ctx);
  const c = ctx.db
    .prepare(
      `SELECT COUNT(*) AS total,
         SUM(status = 'todo') AS todo, SUM(status = 'in_progress') AS in_progress, SUM(status = 'blocked') AS blocked,
         SUM(status = 'review') AS review, SUM(status = 'done') AS done,
         SUM(due_at IS NOT NULL AND due_at < ? AND status != 'done') AS overdue
       FROM tasks WHERE milestone_id = ?`,
    )
    .get(now, r.id) as Record<string, number | null>;
  const n = (k: string) => c[k] ?? 0;
  return {
    ...r,
    // Overdue is derived: a due moment in the past on an open milestone. Nothing changes state by itself.
    overdue: r.state === "open" && r.due_at !== null && r.due_at < now,
    counts: { total: n("total"), todo: n("todo"), in_progress: n("in_progress"), blocked: n("blocked"), review: n("review"), done: n("done"), overdue: n("overdue") },
  };
}

function load(ctx: AppContext, projectId: string, id: string): Row {
  const r = ctx.db.prepare("SELECT * FROM milestones WHERE id = ? AND project_id = ?").get(id, projectId) as Row | undefined;
  if (!r) throw notFound();
  return r;
}

export function listMilestones(ctx: AppContext, projectId: string): MilestoneView[] {
  return (ctx.db.prepare("SELECT * FROM milestones WHERE project_id = ? ORDER BY due_at IS NULL, due_at, created_at").all(projectId) as Row[]).map((r) => view(ctx, r));
}

export function getMilestone(ctx: AppContext, projectId: string, id: string): MilestoneView & { task_ids: string[] } {
  const r = load(ctx, projectId, id);
  const task_ids = (ctx.db.prepare("SELECT id FROM tasks WHERE milestone_id = ? ORDER BY created_at").all(id) as { id: string }[]).map((t) => t.id);
  return { ...view(ctx, r), task_ids };
}

export function createMilestone(ctx: AppContext, projectId: string, actor: Actor, input: { title: string; criteria: string; due_at: string | null }): MilestoneView {
  const id = newId("mil");
  const now = nowIso(ctx);
  const due = resolveDue(input.due_at, projectZone(ctx, projectId));
  ctx.db
    .prepare(`INSERT INTO milestones (id, project_id, title, criteria, due_at, state, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?)`)
    .run(id, projectId, input.title, input.criteria, due, now, now);
  appendEvent(ctx, projectId, actor, { kind: "milestone.created", subjectType: "milestone", subjectId: id, summary: `创建里程碑「${input.title}」`, data: { due_at: due } });
  return view(ctx, load(ctx, projectId, id));
}

function bump(ctx: AppContext, r: Row, expected: number, sets: string, args: unknown[]): void {
  if (r.version !== expected) throw conflict();
  const res = ctx.db.prepare(`UPDATE milestones SET ${sets}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`).run(...args, nowIso(ctx), r.id, expected);
  if (res.changes !== 1) throw conflict();
}

export function editMilestone(ctx: AppContext, projectId: string, actor: Actor, id: string, expected: number, patch: { title?: string | undefined; criteria?: string | undefined; due_at?: string | null | undefined }): MilestoneView {
  const r = load(ctx, projectId, id);
  const due = patch.due_at === undefined ? r.due_at : resolveDue(patch.due_at, projectZone(ctx, projectId));
  bump(ctx, r, expected, "title = ?, criteria = ?, due_at = ?", [patch.title ?? r.title, patch.criteria ?? r.criteria, due]);
  appendEvent(ctx, projectId, actor, {
    kind: "milestone.edited",
    subjectType: "milestone",
    subjectId: id,
    summary: `修改里程碑「${patch.title ?? r.title}」`,
    data: { ...(due !== r.due_at ? { due_at: due, previous_due_at: r.due_at } : {}) },
  });
  return view(ctx, load(ctx, projectId, id));
}

// Adding or removing tasks is an explicit, reasoned scope change. A task belongs to one milestone.
export function changeScope(ctx: AppContext, projectId: string, actor: Actor, id: string, expected: number, add: string[], remove: string[], reason: string): MilestoneView & { task_ids: string[] } {
  const r = load(ctx, projectId, id);
  if (add.length === 0 && remove.length === 0) throw invalid("Nothing to change");
  bump(ctx, r, expected, "title = title", []);
  for (const t of add) {
    const task = loadRow(ctx, projectId, t);
    const current = (ctx.db.prepare("SELECT milestone_id FROM tasks WHERE id = ?").get(task.id) as { milestone_id: string | null }).milestone_id;
    if (current && current !== id) throw invalid(`Task ${t} already belongs to another milestone; remove it there first`);
    ctx.db.prepare("UPDATE tasks SET milestone_id = ?, version = version + 1, updated_at = ? WHERE id = ?").run(id, nowIso(ctx), t);
  }
  for (const t of remove) {
    const res = ctx.db.prepare("UPDATE tasks SET milestone_id = NULL, version = version + 1, updated_at = ? WHERE id = ? AND milestone_id = ?").run(nowIso(ctx), t, id);
    if (res.changes !== 1) throw invalid(`Task ${t} is not part of this milestone`);
  }
  appendEvent(ctx, projectId, actor, {
    kind: "milestone.scope_changed",
    subjectType: "milestone",
    subjectId: id,
    summary: `调整里程碑「${r.title}」范围：加入 ${add.length} 项，移出 ${remove.length} 项`,
    data: { added: add, removed: remove, reason },
  });
  return getMilestone(ctx, projectId, id);
}

// Achievement is a person's explicit confirmation with a note. Unfinished linked tasks block it:
// the scope must be adjusted first (with a reason), so nothing disappears silently.
export function achieveMilestone(ctx: AppContext, projectId: string, actor: Actor, id: string, expected: number, note: string): MilestoneView {
  if (actor.kind !== "user") throw new HttpError(403, "not_allowed", "Only a person can confirm a milestone");
  const r = load(ctx, projectId, id);
  if (r.state === "achieved") throw new HttpError(409, "version_conflict", "The milestone is already achieved");
  const open = ctx.db.prepare("SELECT id, title, status FROM tasks WHERE milestone_id = ? AND status != 'done'").all(id) as { id: string; title: string; status: string }[];
  if (open.length) {
    throw new HttpError(409, "not_allowed", `Unfinished tasks are still in scope: ${open.map((t) => `${t.title} (${t.status})`).join(", ")}. Finish them or remove them from the milestone with a reason first.`);
  }
  const now = nowIso(ctx);
  bump(ctx, r, expected, "state = 'achieved', confirmed_by = ?, confirmed_at = ?, confirm_note = ?", [actor.userId, now, note]);
  appendEvent(ctx, projectId, actor, { kind: "milestone.achieved", subjectType: "milestone", subjectId: id, summary: `确认里程碑「${r.title}」达成`, data: { note } });
  return view(ctx, load(ctx, projectId, id));
}

export function reopenMilestone(ctx: AppContext, projectId: string, actor: Actor, id: string, expected: number, reason: string): MilestoneView {
  if (actor.kind !== "user") throw new HttpError(403, "not_allowed", "Only a person can reopen a milestone");
  const r = load(ctx, projectId, id);
  if (r.state !== "achieved") throw new HttpError(409, "version_conflict", "The milestone is not achieved");
  bump(ctx, r, expected, "state = 'open', confirmed_by = NULL, confirmed_at = NULL, confirm_note = NULL", []);
  appendEvent(ctx, projectId, actor, { kind: "milestone.reopened", subjectType: "milestone", subjectId: id, summary: `重开里程碑「${r.title}」`, data: { reason } });
  return view(ctx, load(ctx, projectId, id));
}

export function setTaskDue(ctx: AppContext, projectId: string, actor: Actor, taskId: string, expected: number, due: string | null): void {
  const t = loadRow(ctx, projectId, taskId);
  if (t.version !== expected) throw new HttpError(409, "version_conflict", "The task was changed by someone else; refresh and try again");
  const resolved = resolveDue(due, projectZone(ctx, projectId));
  ctx.db.prepare("UPDATE tasks SET due_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(resolved, nowIso(ctx), taskId, expected);
  appendEvent(ctx, projectId, actor, { kind: "task.due_changed", subjectType: "task", subjectId: taskId, summary: `调整任务「${t.title}」截止时间`, data: { due_at: resolved } });
}

export function setProjectDue(ctx: AppContext, projectId: string, actor: Actor, due: string | null): string | null {
  const resolved = resolveDue(due, projectZone(ctx, projectId));
  ctx.db.prepare("UPDATE projects SET due_at = ? WHERE id = ?").run(resolved, projectId);
  appendEvent(ctx, projectId, actor, { kind: "project.due_changed", subjectType: "project", subjectId: projectId, summary: "调整项目截止时间", data: { due_at: resolved } });
  return resolved;
}
