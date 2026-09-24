import { authorKind, normalizeRemote, type HandoffView, type ReceiverCheck, type SenderGit } from "@coagents/contract";
import { checkSubmissionVersions, describeVersions } from "./artifacts.js";
import { nowIso, type Actor, type AppContext } from "./context.js";
import { appendEvent } from "./events.js";
import { HttpError, invalid, notAllowed, notFound } from "./http-error.js";
import { newId } from "./ids.js";
import { claimTask, loadRow, requireHolder, transition } from "./tasks.js";
import { isManager, type Viewer } from "./visibility.js";

interface HandoffRow {
  id: string;
  project_id: string;
  task_id: string;
  task_title: string;
  state: "pending" | "accepted" | "cancelled";
  from_holder_kind: "user" | "client";
  from_holder_id: string;
  from_user_id: string;
  from_name: string;
  from_device_id: string;
  target_user_id: string | null;
  summary: string;
  next_steps: string;
  next_step_items: string;
  risks: string | null;
  git: string | null;
  artifact_version_ids: string;
  last_check: string | null;
  created_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
}

const SELECT = `SELECT h.*, t.title AS task_title, u.display_name AS from_name
  FROM handoffs h JOIN tasks t ON t.id = h.task_id JOIN users u ON u.id = h.from_user_id`;

function view(ctx: AppContext, r: HandoffRow, viewer: Viewer): HandoffView {
  return {
    id: r.id,
    project_id: r.project_id,
    task_id: r.task_id,
    task_title: r.task_title,
    state: r.state,
    from: {
      user_id: r.from_user_id,
      display_name: r.from_name,
      holder_kind: r.from_holder_kind,
      author_kind: authorKind(r.from_holder_kind === "client" ? r.from_holder_id : null),
      device_id: r.from_device_id,
    },
    target_user_id: r.target_user_id,
    summary: r.summary,
    next_steps: r.next_steps,
    next_step_items: JSON.parse(r.next_step_items) as string[],
    risks: r.risks,
    git: r.git ? (JSON.parse(r.git) as SenderGit) : null,
    artifacts: describeVersions(ctx, r.project_id, viewer, JSON.parse(r.artifact_version_ids) as string[]),
    last_check: r.last_check ? (JSON.parse(r.last_check) as HandoffView["last_check"]) : null,
    created_at: r.created_at,
    accepted_at: r.accepted_at,
    accepted_by: r.accepted_by,
  };
}

function load(ctx: AppContext, projectId: string, id: string): HandoffRow {
  const r = ctx.db.prepare(`${SELECT} WHERE h.id = ? AND h.project_id = ?`).get(id, projectId) as HandoffRow | undefined;
  if (!r) throw notFound();
  return r;
}

export function listHandoffs(ctx: AppContext, projectId: string, viewer: Viewer, filter: { state?: string | undefined; taskId?: string | undefined }): HandoffView[] {
  const rows = ctx.db
    .prepare(`${SELECT} WHERE h.project_id = ? ${filter.state ? "AND h.state = ?" : ""} ${filter.taskId ? "AND h.task_id = ?" : ""} ORDER BY h.created_at DESC LIMIT 100`)
    .all(projectId, ...(filter.state ? [filter.state] : []), ...(filter.taskId ? [filter.taskId] : [])) as HandoffRow[];
  return rows.map((r) => view(ctx, r, viewer));
}

export function getHandoff(ctx: AppContext, projectId: string, viewer: Viewer, id: string): HandoffView {
  return view(ctx, load(ctx, projectId, id), viewer);
}

export interface PrepareHandoff {
  lease_token?: string | undefined;
  summary: string;
  next_steps?: string | undefined;
  next_step_items?: string[] | undefined;
  risks?: string | undefined;
  target_user_id?: string | undefined;
  git?: SenderGit | undefined;
  artifact_version_ids: string[];
}

// The holder records what is done, what is next and where the material is, then gives the task
// back. Uncommitted or unpushed code is never "handed over": the sender must deliver it first.
export function prepareHandoff(ctx: AppContext, projectId: string, actor: Actor, viewer: Viewer, taskId: string, input: PrepareHandoff): HandoffView {
  const row = loadRow(ctx, projectId, taskId);
  requireHolder(ctx, row, actor, input.lease_token);
  if (input.git) {
    const blocked = [
      ...(input.git.dirty ? ["the working copy has uncommitted changes; commit them first"] : []),
      ...(input.git.pushed ? [] : ["the commit is not on any remote branch; push it first"]),
    ];
    if (blocked.length) throw new HttpError(409, "handoff_blocked", `Cannot hand over undelivered code: ${blocked.join("; ")}`);
  }
  checkSubmissionVersions(ctx, projectId, input.artifact_version_ids);
  if (input.target_user_id) {
    const m = ctx.db.prepare("SELECT role FROM memberships WHERE project_id = ? AND user_id = ?").get(projectId, input.target_user_id) as { role: string } | undefined;
    if (!m || m.role === "viewer") throw invalid("target_user_id must be a project member who can work on tasks");
  }
  const now = nowIso(ctx);
  ctx.db.prepare("UPDATE handoffs SET state = 'cancelled', cancelled_at = ? WHERE task_id = ? AND state = 'pending'").run(now, taskId);
  const id = newId("hof");
  ctx.db
    .prepare(
      `INSERT INTO handoffs (id, project_id, task_id, state, from_holder_kind, from_holder_id, from_user_id, from_device_id, target_user_id, summary, next_steps, next_step_items, risks, git, artifact_version_ids, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      taskId,
      actor.kind,
      actor.kind === "client" ? actor.clientId! : actor.userId,
      actor.userId,
      actor.deviceId,
      input.target_user_id ?? null,
      input.summary,
      // A list is also kept as numbered prose, so every reader has next_steps.
      input.next_steps ?? input.next_step_items!.map((s, i) => `${i + 1}. ${s}`).join("\n"),
      JSON.stringify(input.next_step_items ?? []),
      input.risks ?? null,
      input.git ? JSON.stringify({ ...input.git, repo_identity: normalizeRemote(input.git.repo_identity) }) : null,
      JSON.stringify(input.artifact_version_ids),
      now,
    );
  // Releasing the lease sends the card back to todo; the receiver claims it again on acceptance.
  transition(ctx, row, "todo", true);
  appendEvent(ctx, projectId, actor, {
    kind: "handoff.prepared",
    subjectType: "task",
    subjectId: taskId,
    summary: `交接任务「${row.title}」${input.git ? `（${input.git.branch} @ ${input.git.commit.slice(0, 10)}）` : ""}`,
    data: { handoff_id: id, ...(input.target_user_id ? { target_user_id: input.target_user_id } : {}) },
  });
  return getHandoff(ctx, projectId, viewer, id);
}

// Acceptance compares the receiver's own read-only check with what the sender recorded, and
// confirms the artifact versions are still published and readable by the receiver. The outcome of
// every check is kept on the handoff (also when it fails) so the Hub can show why.
export function checkHandoff(ctx: AppContext, projectId: string, actor: Actor, viewer: Viewer, id: string, check: ReceiverCheck | undefined): void {
  const h = load(ctx, projectId, id);
  if (h.state !== "pending") throw new HttpError(409, "handoff_check_failed", `This handoff is ${h.state}`);
  if (h.target_user_id && h.target_user_id !== actor.userId) throw notAllowed("This handoff is addressed to someone else");
  const reasons: string[] = [];
  const warnings: string[] = [];
  const git = h.git ? (JSON.parse(h.git) as SenderGit) : null;
  if (git) {
    if (!check) reasons.push("a code handoff must be accepted from the working copy through the Connector, which checks the repository");
    else {
      if (normalizeRemote(check.repo_identity) !== git.repo_identity) reasons.push(`your working copy is ${normalizeRemote(check.repo_identity)}, the handoff is for ${git.repo_identity}`);
      if (!check.has_commit) reasons.push(`commit ${git.commit} is not in your working copy; fetch ${git.branch} first (nothing was changed on your side)`);
      if (check.dirty) warnings.push("your working copy has uncommitted changes; CoAgents did not touch them");
    }
  }
  for (const a of describeVersions(ctx, projectId, viewer, JSON.parse(h.artifact_version_ids) as string[])) {
    if (!a.readable) reasons.push(`artifact version ${a.version_id} is not readable for you or no longer published`);
  }
  const record = { ok: reasons.length === 0, reasons, warnings, checked_at: nowIso(ctx), device_id: actor.deviceId };
  ctx.db.prepare("UPDATE handoffs SET last_check = ? WHERE id = ?").run(JSON.stringify(record), id);
  if (reasons.length) throw new HttpError(409, "handoff_check_failed", `Cannot take over yet: ${reasons.join("; ")}`);
}

// After a passing check: claim the task with a fresh lease and mark the handoff accepted, atomically.
// A competing claim in between makes this fail with task_already_held.
export function completeHandoff(ctx: AppContext, projectId: string, actor: Actor, viewer: Viewer, id: string): { handoff: HandoffView; lease_token: string; lease_until: string } {
  const h = load(ctx, projectId, id);
  const check = h.last_check ? (JSON.parse(h.last_check) as { ok: boolean; warnings: string[] }) : null;
  if (h.state !== "pending" || !check?.ok) throw new HttpError(409, "handoff_check_failed", "Run the handoff check first");
  const claim = claimTask(ctx, projectId, actor, h.task_id, { viaHandoff: true });
  ctx.db.prepare("UPDATE handoffs SET state = 'accepted', accepted_at = ?, accepted_by = ? WHERE id = ?").run(nowIso(ctx), actor.userId, id);
  appendEvent(ctx, projectId, actor, {
    kind: "handoff.accepted",
    subjectType: "task",
    subjectId: h.task_id,
    summary: `接手任务「${h.task_title}」`,
    data: { handoff_id: id, ...(check.warnings.length ? { warnings: check.warnings } : {}) },
  });
  return { handoff: getHandoff(ctx, projectId, viewer, id), lease_token: claim.lease_token, lease_until: claim.lease_until };
}

export function cancelHandoff(ctx: AppContext, projectId: string, actor: Actor, viewer: Viewer, id: string): HandoffView {
  const h = load(ctx, projectId, id);
  if (h.state !== "pending") throw new HttpError(409, "handoff_check_failed", `This handoff is ${h.state}`);
  if (h.from_user_id !== actor.userId && !isManager(viewer)) throw notAllowed();
  ctx.db.prepare("UPDATE handoffs SET state = 'cancelled', cancelled_at = ? WHERE id = ?").run(nowIso(ctx), id);
  appendEvent(ctx, projectId, actor, { kind: "handoff.cancelled", subjectType: "task", subjectId: h.task_id, summary: `取消任务「${h.task_title}」的交接`, data: { handoff_id: id } });
  return getHandoff(ctx, projectId, viewer, id);
}
