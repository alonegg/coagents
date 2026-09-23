import { canClaim, nextStatus, type ClaimResult, type TaskAction, type TaskStatus, type TaskView } from "@coagents/contract";
import { nowIso, type Actor, type AppContext } from "./context.js";
import { appendEvent } from "./events.js";
import { HttpError, invalid, notFound } from "./http-error.js";
import { hashSecret, newId, newSecret } from "./ids.js";

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  assignee_id: string | null;
  status: TaskStatus;
  holder_kind: "user" | "client" | null;
  holder_id: string | null;
  holder_user_id: string | null;
  holder_device_id: string | null;
  holder_name: string | null;
  lease_token_hash: string | null;
  lease_until: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const SELECT_TASK = `SELECT t.*, hu.display_name AS holder_name FROM tasks t LEFT JOIN users hu ON hu.id = t.holder_user_id`;

const versionConflict = () =>
  new HttpError(409, "version_conflict", "The task was changed by someone else; refresh and try again");
const leaseInvalid = () =>
  new HttpError(409, "lease_invalid", "You do not hold a valid lease on this task; claim it again");

function loadRow(ctx: AppContext, projectId: string, taskId: string): TaskRow {
  const row = ctx.db.prepare(`${SELECT_TASK} WHERE t.id = ? AND t.project_id = ?`).get(taskId, projectId) as TaskRow | undefined;
  if (!row) throw notFound();
  return row;
}

function leaseActive(row: TaskRow, now: string): boolean {
  return row.lease_until !== null && row.lease_until > now;
}

function toView(row: TaskRow, now: string): TaskView {
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    description: row.description,
    acceptance_criteria: row.acceptance_criteria,
    assignee_id: row.assignee_id,
    status: row.status,
    holder:
      row.holder_kind && row.holder_id && row.holder_user_id && row.holder_device_id && row.lease_until
        ? {
            kind: row.holder_kind,
            id: row.holder_id,
            user_id: row.holder_user_id,
            display_name: row.holder_name ?? "",
            device_id: row.holder_device_id,
            lease_until: row.lease_until,
            lease_active: leaseActive(row, now),
          }
        : null,
    version: row.version,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getTask(ctx: AppContext, projectId: string, taskId: string): TaskView {
  return toView(loadRow(ctx, projectId, taskId), nowIso(ctx));
}

export function listTasks(ctx: AppContext, projectId: string, status?: TaskStatus): TaskView[] {
  const now = nowIso(ctx);
  const rows = (
    status
      ? ctx.db.prepare(`${SELECT_TASK} WHERE t.project_id = ? AND t.status = ? ORDER BY t.created_at`).all(projectId, status)
      : ctx.db.prepare(`${SELECT_TASK} WHERE t.project_id = ? ORDER BY t.created_at`).all(projectId)
  ) as TaskRow[];
  return rows.map((r) => toView(r, now));
}

function assertMember(ctx: AppContext, projectId: string, userId: string | null): void {
  if (userId === null) return;
  const ok = ctx.db.prepare("SELECT 1 FROM memberships WHERE project_id = ? AND user_id = ?").get(projectId, userId);
  if (!ok) throw invalid("assignee_id must be a project member");
}

export interface CreateTask {
  title: string;
  description: string;
  acceptance_criteria: string;
  assignee_id: string | null;
}

export function createTask(ctx: AppContext, projectId: string, actor: Actor, input: CreateTask): TaskView {
  assertMember(ctx, projectId, input.assignee_id);
  const id = newId("tsk");
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, assignee_id, status, version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'todo', 1, ?, ?, ?)`,
    )
    .run(id, projectId, input.title, input.description, input.acceptance_criteria, input.assignee_id, actor.userId, now, now);
  appendEvent(ctx, projectId, actor, {
    kind: "task.created",
    subjectType: "task",
    subjectId: id,
    summary: `创建任务「${input.title}」`,
    data: input.assignee_id ? { assignee_id: input.assignee_id } : {},
  });
  return getTask(ctx, projectId, id);
}

export function editTask(
  ctx: AppContext,
  projectId: string,
  actor: Actor,
  taskId: string,
  expectedVersion: number,
  patch: { [K in keyof CreateTask]?: CreateTask[K] | undefined },
): TaskView {
  const row = loadRow(ctx, projectId, taskId);
  if (row.version !== expectedVersion) throw versionConflict();
  if (patch.assignee_id !== undefined) assertMember(ctx, projectId, patch.assignee_id);
  const next = {
    title: patch.title ?? row.title,
    description: patch.description ?? row.description,
    acceptance_criteria: patch.acceptance_criteria ?? row.acceptance_criteria,
    assignee_id: patch.assignee_id === undefined ? row.assignee_id : patch.assignee_id,
  };
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== row[k]);
  if (changed.length === 0) return toView(row, nowIso(ctx));
  ctx.db
    .prepare(
      `UPDATE tasks SET title = ?, description = ?, acceptance_criteria = ?, assignee_id = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .run(next.title, next.description, next.acceptance_criteria, next.assignee_id, nowIso(ctx), taskId, expectedVersion);
  appendEvent(ctx, projectId, actor, {
    kind: next.assignee_id !== row.assignee_id ? "task.assigned" : "task.edited",
    subjectType: "task",
    subjectId: taskId,
    summary: `修改任务「${next.title}」`,
    data: { fields: changed, ...(next.assignee_id !== row.assignee_id ? { assignee_id: next.assignee_id } : {}) },
  });
  return getTask(ctx, projectId, taskId);
}

// Clearing the holder always goes together with a status change and a version bump.
function transition(ctx: AppContext, row: TaskRow, to: TaskStatus, clearLease: boolean): void {
  const res = ctx.db
    .prepare(
      `UPDATE tasks SET status = ?, version = version + 1, updated_at = ?
       ${clearLease ? ", holder_kind = NULL, holder_id = NULL, holder_user_id = NULL, holder_device_id = NULL, lease_token_hash = NULL, lease_until = NULL" : ""}
       WHERE id = ? AND version = ?`,
    )
    .run(to, nowIso(ctx), row.id, row.version);
  if (res.changes !== 1) throw versionConflict();
}

function requireTransition(action: TaskAction, row: TaskRow): TaskStatus {
  const to = nextStatus(action, row.status);
  if (!to) throw new HttpError(409, "task_not_claimable", `Cannot ${action} a task that is ${row.status}`);
  return to;
}

export function claimTask(ctx: AppContext, projectId: string, actor: Actor, taskId: string): ClaimResult {
  const row = loadRow(ctx, projectId, taskId);
  const now = ctx.clock();
  const nowS = now.toISOString();
  if (row.status === "in_progress" && leaseActive(row, nowS)) {
    throw new HttpError(409, "task_already_held", `Task is held by ${row.holder_name ?? "another executor"} until ${row.lease_until}`);
  }
  if (!canClaim(row.status, leaseActive(row, nowS))) {
    throw new HttpError(409, "task_not_claimable", `A task that is ${row.status} cannot be claimed`);
  }
  const token = newSecret();
  const leaseUntil = new Date(now.getTime() + ctx.config.leaseMinutes * 60_000).toISOString();
  const holderId = actor.kind === "client" ? actor.clientId! : actor.userId;
  const res = ctx.db
    .prepare(
      `UPDATE tasks SET status = 'in_progress', holder_kind = ?, holder_id = ?, holder_user_id = ?, holder_device_id = ?,
         lease_token_hash = ?, lease_until = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .run(actor.kind, holderId, actor.userId, actor.deviceId, hashSecret(token), leaseUntil, nowS, taskId, row.version);
  if (res.changes !== 1) throw versionConflict();
  appendEvent(ctx, projectId, actor, {
    kind: "task.claimed",
    subjectType: "task",
    subjectId: taskId,
    summary: `认领任务「${row.title}」`,
    data: { from_status: row.status, lease_until: leaseUntil, ...(row.holder_id && row.holder_id !== holderId ? { previous_holder: row.holder_id } : {}) },
  });
  return { task: getTask(ctx, projectId, taskId), lease_token: token, lease_until: leaseUntil };
}

// Agents prove holding with the lease token; a person proves it with the session's user and device.
// Either way the lease must still be active; a lapsed lease can never write again.
function requireHolder(ctx: AppContext, row: TaskRow, actor: Actor, leaseToken: string | undefined): void {
  if (row.status !== "in_progress" || !leaseActive(row, nowIso(ctx))) throw leaseInvalid();
  const holderId = actor.kind === "client" ? actor.clientId : actor.userId;
  if (row.holder_kind !== actor.kind || row.holder_id !== holderId) throw leaseInvalid();
  if (leaseToken !== undefined) {
    if (hashSecret(leaseToken) !== row.lease_token_hash) throw leaseInvalid();
  } else if (actor.kind === "client" || row.holder_device_id !== actor.deviceId) {
    throw leaseInvalid();
  }
}

export function renewLease(ctx: AppContext, projectId: string, actor: Actor, taskId: string, leaseToken?: string): { task: TaskView; lease_until: string } {
  const row = loadRow(ctx, projectId, taskId);
  requireHolder(ctx, row, actor, leaseToken);
  const leaseUntil = new Date(ctx.clock().getTime() + ctx.config.leaseMinutes * 60_000).toISOString();
  // Renewal is not a business activity: no event, no version bump, so it never conflicts with edits.
  ctx.db.prepare("UPDATE tasks SET lease_until = ? WHERE id = ?").run(leaseUntil, taskId);
  return { task: getTask(ctx, projectId, taskId), lease_until: leaseUntil };
}

export function releaseTask(ctx: AppContext, projectId: string, actor: Actor, taskId: string, leaseToken: string | undefined, note?: string): TaskView {
  const row = loadRow(ctx, projectId, taskId);
  requireHolder(ctx, row, actor, leaseToken);
  transition(ctx, row, requireTransition("release", row), true);
  appendEvent(ctx, projectId, actor, {
    kind: "task.released",
    subjectType: "task",
    subjectId: taskId,
    summary: `释放任务「${row.title}」`,
    data: note ? { note } : {},
  });
  return getTask(ctx, projectId, taskId);
}

export function blockTask(ctx: AppContext, projectId: string, actor: Actor, taskId: string, leaseToken: string | undefined, body: string): { event_seq: number; task: TaskView } {
  const row = loadRow(ctx, projectId, taskId);
  requireHolder(ctx, row, actor, leaseToken);
  transition(ctx, row, requireTransition("block", row), true);
  const seq = appendEvent(ctx, projectId, actor, {
    kind: "blocker.reported",
    subjectType: "task",
    subjectId: taskId,
    summary: `任务「${row.title}」受阻`,
    data: { body },
  });
  return { event_seq: seq, task: getTask(ctx, projectId, taskId) };
}

export function submitTask(
  ctx: AppContext,
  projectId: string,
  actor: Actor,
  taskId: string,
  input: { lease_token?: string | undefined; summary: string; artifact_version_ids: string[]; evidence?: string | undefined },
): { submission_id: string; task: TaskView } {
  const row = loadRow(ctx, projectId, taskId);
  requireHolder(ctx, row, actor, input.lease_token);
  if (input.artifact_version_ids.length > 0) {
    // Artifact versions arrive in M5; until then a submission must carry written evidence.
    throw invalid("Artifact versions are not available yet; attach written evidence instead");
  }
  if (!input.evidence) throw invalid("A submission needs evidence or artifact versions");
  transition(ctx, row, requireTransition("submit", row), true);
  const id = newId("sub");
  ctx.db
    .prepare(
      `INSERT INTO task_submissions (id, task_id, summary, artifact_version_ids, evidence, submitted_by_user, submitted_by_client, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, taskId, input.summary, JSON.stringify(input.artifact_version_ids), input.evidence, actor.userId, actor.clientId, nowIso(ctx));
  appendEvent(ctx, projectId, actor, {
    kind: "task.submitted",
    subjectType: "task",
    subjectId: taskId,
    summary: `提交任务「${row.title}」待验收`,
    data: { submission_id: id },
  });
  return { submission_id: id, task: getTask(ctx, projectId, taskId) };
}

type ReviewAction = "accept" | "reject" | "reopen" | "terminate";

// Human review actions. Callers must already have checked the task.review permission and that the
// actor is a person, not an agent client.
export function reviewTask(
  ctx: AppContext,
  projectId: string,
  actor: Actor,
  taskId: string,
  action: ReviewAction,
  expectedVersion: number,
  note?: string,
): TaskView {
  if (actor.kind !== "user") throw new HttpError(403, "not_allowed", "Only a person can review tasks");
  const row = loadRow(ctx, projectId, taskId);
  if (row.version !== expectedVersion) throw versionConflict();
  const now = nowIso(ctx);
  let to: TaskStatus;
  if (action === "terminate") {
    if (row.holder_kind === null) throw new HttpError(409, "lease_invalid", "The task has no lease to terminate");
    to = "todo";
  } else {
    to = requireTransition(action, row);
  }
  transition(ctx, row, to, true);
  if (action === "accept" || action === "reject") {
    const sub = ctx.db
      .prepare("SELECT id FROM task_submissions WHERE task_id = ? AND outcome IS NULL ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as { id: string } | undefined;
    if (sub) {
      ctx.db
        .prepare("UPDATE task_submissions SET outcome = ?, reviewed_by = ?, review_note = ?, reviewed_at = ? WHERE id = ?")
        .run(action === "accept" ? "accepted" : "rejected", actor.userId, note ?? null, now, sub.id);
    }
  }
  const labels: Record<ReviewAction, string> = { accept: "接受", reject: "退回", reopen: "重开", terminate: "终止租约" };
  appendEvent(ctx, projectId, actor, {
    kind: `task.${action === "terminate" ? "lease_terminated" : action === "accept" ? "accepted" : action === "reject" ? "rejected" : "reopened"}`,
    subjectType: "task",
    subjectId: taskId,
    summary: `${labels[action]}任务「${row.title}」`,
    data: { ...(note ? { note } : {}), ...(action === "terminate" && row.holder_id ? { previous_holder: row.holder_id } : {}) },
  });
  return getTask(ctx, projectId, taskId);
}

export function listSubmissions(ctx: AppContext, taskId: string): unknown[] {
  return ctx.db
    .prepare(
      `SELECT s.id, s.summary, s.artifact_version_ids, s.evidence, s.submitted_by_user, s.submitted_by_client, s.created_at,
              s.outcome, s.reviewed_by, s.review_note, s.reviewed_at
       FROM task_submissions s WHERE s.task_id = ? ORDER BY s.created_at DESC`,
    )
    .all(taskId)
    .map((r) => {
      const row = r as { artifact_version_ids: string };
      return { ...row, artifact_version_ids: JSON.parse(row.artifact_version_ids) as string[] };
    });
}
