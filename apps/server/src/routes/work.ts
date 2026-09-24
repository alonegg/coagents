import {
  CreateTaskInput,
  DecisionInput,
  EditTaskInput,
  HelpRequestInput,
  HUMAN_ONLY,
  type HumanOnlyAction,
  HttpBlockerInput,
  HttpClaimInput,
  HttpReleaseInput,
  HttpRenewInput,
  HttpSubmitInput,
  ReasonedReviewInput,
  ReviewInput,
  TaskStatus,
  type EventView,
  type Permission,
} from "@coagents/contract";
import { Hono, type Context } from "hono";
import { projectAccess, requireActive, requirePermission, type ProjectAccess } from "../access.js";
import { requireAuth, type Env } from "../auth.js";
import { agentPause, overBudget, interruptLimit } from "../attention.js";
import { projectMetrics } from "../metrics.js";
import type { Actor, AppContext } from "../context.js";
import { listDecisions, publishDecision, publishGeneralBlocker } from "../decisions.js";
import { ackCursor, appendEvent, listEvents, markStreamDelivered, MAX_EVENT_PAGE, readCursor } from "../events.js";
import { resumeCursor, sse } from "../stream.js";
import { describeVersions } from "../artifacts.js";
import { sessionStillValid } from "../auth.js";
import { HttpError, invalid, notAllowed, notFound } from "../http-error.js";
import { clientStillValid, requireAgentPermission, type AgentState } from "../agents.js";
import { idempotent, type StoredResult } from "../idempotency.js";
import {
  blockTask,
  claimTask,
  createTask,
  editTask,
  getTask,
  listSubmissions,
  listTasks,
  releaseTask,
  renewLease,
  reviewTask,
  submitTask,
} from "../tasks.js";
import { parseBody } from "../validate.js";

// Resolves the caller as a person (session) or an agent (bearer token) with project access.
// An agent token only ever reaches its own project; any other project id looks nonexistent.
export function actorFor(ctx: AppContext, c: Context<Env>): { actor: Actor; access: ProjectAccess; agent: AgentState | null; paused?: "project" | "connection" | null } {
  const agent = c.get("agent");
  const projectId = c.req.param("id")!;
  if (agent) {
    if (agent.projectId !== projectId) throw notFound();
    const access = projectAccess(ctx, agent.userId, projectId);
    requireAgentPermission(agent, access.role, "project.read");
    return {
      actor: { kind: "client", userId: agent.userId, displayName: agent.displayName, deviceId: agent.deviceId, clientId: agent.clientId },
      access,
      agent,
      paused: agentPause(ctx, projectId, agent.clientId),
    };
  }
  const auth = requireAuth(c);
  const access = projectAccess(ctx, auth.user.id, projectId);
  return {
    actor: { kind: "user", userId: auth.user.id, displayName: auth.user.display_name, deviceId: auth.deviceId, clientId: null },
    access,
    agent: null,
  };
}

// The single gate for project writes. A paused agent (whole project or its own connection) can
// still read but not write.
export function checkPermission(ctx: { access: ProjectAccess; agent: AgentState | null; paused?: "project" | "connection" | null }, permission: Permission): void {
  if (ctx.agent) {
    requireAgentPermission(ctx.agent, ctx.access.role, permission);
    if (permission !== "project.read" && ctx.paused) {
      throw new HttpError(
        423,
        "agents_paused",
        ctx.paused === "project" ? "A person paused all agents in this project; you can read but not write" : "A person paused this agent connection; you can read but not write",
      );
    }
  } else requirePermission(ctx.access, permission);
}

// Actions on the human side of the boundary (@coagents/contract HUMAN_ONLY).
export function requireHuman(ctx: { agent: AgentState | null }, action: HumanOnlyAction): void {
  if (ctx.agent) throw notAllowed(`Only a person can do this: ${HUMAN_ONLY[action]}`);
}

function consumerOf(actor: Actor): { kind: "device" | "client"; id: string } {
  return actor.kind === "client" ? { kind: "client", id: actor.clientId! } : { kind: "device", id: actor.deviceId };
}

function reply(c: Context<Env>, r: StoredResult) {
  return c.json(r.body as object, r.status);
}

export function workRoutes(ctx: AppContext): Hono<Env> {
  const r = new Hono<Env>();

  // Wraps a project write: access, permission, active project, input validation and idempotency.
  function write(
    c: Context<Env>,
    input: { request_id: string },
    scope: string,
    fn: (actor: Actor, access: ProjectAccess) => StoredResult,
  ) {
    const resolved = actorFor(ctx, c);
    const { actor, access } = resolved;
    checkPermission(resolved, "task.write");
    requireActive(access);
    return reply(c, idempotent(ctx, actor, input.request_id, `${scope}:${access.projectId}`, () => fn(actor, access)));
  }

  r.get("/:id/tasks", (c) => {
    const { access } = actorFor(ctx, c);
    const status = c.req.query("status");
    const parsed = status === undefined ? undefined : TaskStatus.safeParse(status);
    if (parsed && !parsed.success) throw invalid("Unknown status filter");
    return c.json({ tasks: listTasks(ctx, access.projectId, parsed?.data) });
  });

  r.post("/:id/tasks", async (c) => {
    const input = await parseBody(c, CreateTaskInput);
    return write(c, input, "task.create", (actor, access) => ({
      status: 201,
      body: createTask(ctx, access.projectId, actor, input),
    }));
  });

  r.get("/:id/tasks/:taskId", (c) => {
    const { actor, access } = actorFor(ctx, c);
    const task = getTask(ctx, access.projectId, c.req.param("taskId"));
    const viewer = { userId: actor.userId, role: access.role };
    const submissions = listSubmissions(ctx, task.id).map((s) => ({
      ...s,
      artifacts: describeVersions(ctx, access.projectId, viewer, s.artifact_version_ids),
    }));
    return c.json({ ...task, submissions });
  });

  r.patch("/:id/tasks/:taskId", async (c) => {
    const input = await parseBody(c, EditTaskInput);
    const { expected_version, request_id: _r, ...patch } = input;
    return write(c, input, `task.edit:${c.req.param("taskId")}`, (actor, access) => ({
      status: 200,
      body: editTask(ctx, access.projectId, actor, c.req.param("taskId"), expected_version, patch),
    }));
  });

  r.post("/:id/tasks/:taskId/claim", async (c) => {
    const input = await parseBody(c, HttpClaimInput);
    return write(c, input, `task.claim:${c.req.param("taskId")}`, (actor, access) => ({
      status: 200,
      body: claimTask(ctx, access.projectId, actor, c.req.param("taskId")),
    }));
  });

  r.post("/:id/tasks/:taskId/renew", async (c) => {
    const input = await parseBody(c, HttpRenewInput);
    return write(c, input, `task.renew:${c.req.param("taskId")}`, (actor, access) => ({
      status: 200,
      body: renewLease(ctx, access.projectId, actor, c.req.param("taskId"), input.lease_token),
    }));
  });

  r.post("/:id/tasks/:taskId/release", async (c) => {
    const input = await parseBody(c, HttpReleaseInput);
    return write(c, input, `task.release:${c.req.param("taskId")}`, (actor, access) => ({
      status: 200,
      body: releaseTask(ctx, access.projectId, actor, c.req.param("taskId"), input.lease_token, input.note),
    }));
  });

  r.post("/:id/tasks/:taskId/submit", async (c) => {
    const input = await parseBody(c, HttpSubmitInput);
    return write(c, input, `task.submit:${c.req.param("taskId")}`, (actor, access) => ({
      status: 200,
      body: submitTask(ctx, access.projectId, actor, c.req.param("taskId"), input),
    }));
  });

  // Human review. Agents never reach these: reviewTask rejects client actors, and M3 keeps them off the route.
  for (const action of ["accept", "reject", "reopen", "terminate"] as const) {
    r.post(`/:id/tasks/:taskId/${action}`, async (c) => {
      const input = action === "accept" ? await parseBody(c, ReviewInput) : await parseBody(c, ReasonedReviewInput);
      const resolved = actorFor(ctx, c);
      const { actor, access } = resolved;
      requireHuman(resolved, "task.review");
      requirePermission(access, "task.review");
      requireActive(access);
      const note = "reason" in input ? input.reason : input.note;
      return reply(
        c,
        idempotent(ctx, actor, input.request_id, `task.${action}:${c.req.param("taskId")}:${access.projectId}`, () => ({
          status: 200,
          body: reviewTask(ctx, access.projectId, actor, c.req.param("taskId"), action, input.expected_version, note),
        })),
      );
    });
  }

  r.post("/:id/blockers", async (c) => {
    const input = await parseBody(c, HttpBlockerInput);
    const { task_id, lease_token, request_id: _r, ...blocker } = input;
    return write(c, input, "blocker", (actor, access) => {
      if (task_id) {
        return { status: 201, body: blockTask(ctx, access.projectId, actor, task_id, lease_token, blocker) };
      }
      if (lease_token) throw invalid("lease_token needs task_id");
      return { status: 201, body: { event_seq: publishGeneralBlocker(ctx, access.projectId, actor, blocker), task: null } };
    });
  });

  // Ask a member for help on a task without changing its state: an event and a notification.
  r.post("/:id/tasks/:taskId/help-requests", async (c) => {
    const input = await parseBody(c, HelpRequestInput);
    return write(c, input, `help:${c.req.param("taskId")}`, (actor, access) => {
      const task = getTask(ctx, access.projectId, c.req.param("taskId"));
      if (input.user_id === actor.userId) throw invalid("Ask someone other than yourself");
      const member = ctx.db.prepare("SELECT 1 FROM memberships WHERE project_id = ? AND user_id = ?").get(access.projectId, input.user_id);
      if (!member) throw invalid("user_id must be a project member");
      // A help request is nothing but an interruption: past the person's budget it is refused.
      if (actor.kind === "client" && overBudget(ctx, access.projectId, input.user_id)) {
        throw new HttpError(
          429,
          "attention_budget_exceeded",
          `That person already received ${interruptLimit(ctx, access.projectId)} agent requests in this project in the last 24 hours`,
        );
      }
      const seq = appendEvent(ctx, access.projectId, actor, {
        kind: "task.help_requested",
        subjectType: "task",
        subjectId: task.id,
        summary: `请求协助任务「${task.title}」`,
        data: { user_id: input.user_id, note: input.note },
      });
      return { status: 201, body: { event_seq: seq } };
    });
  });

  r.get("/:id/metrics", (c) => {
    const { access } = actorFor(ctx, c);
    const days = Number(c.req.query("days") ?? 30);
    if (![7, 30, 90].includes(days)) throw invalid("days must be 7, 30 or 90");
    return c.json(projectMetrics(ctx, access.projectId, days));
  });

  r.get("/:id/decisions", (c) => {
    const { access } = actorFor(ctx, c);
    return c.json({ decisions: listDecisions(ctx, access.projectId, c.req.query("history") === "1") });
  });

  r.post("/:id/decisions", async (c) => {
    const input = await parseBody(c, DecisionInput);
    return write(c, input, "decision", (actor, access) => ({
      status: 201,
      body: publishDecision(ctx, access.projectId, actor, input.body, input.supersedes_id),
    }));
  });

  r.get("/:id/events", (c) => {
    const { actor, access } = actorFor(ctx, c);
    const cursor = Number(c.req.query("cursor") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 50), MAX_EVENT_PAGE);
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1) throw invalid("Bad cursor or limit");
    return c.json(listEvents(ctx, access.projectId, cursor, limit, { userId: actor.userId, role: access.role }));
  });

  // Live events for this project. Re-authorizes the session or agent and project membership before
  // every delivery, so a revoked device, client or member stops receiving immediately.
  r.get("/:id/stream", (c) => {
    const resolved = actorFor(ctx, c);
    const { actor, access, agent } = resolved;
    const sessionId = c.get("auth")?.sessionId;
    const consumer = consumerOf(actor);
    const latest = (ctx.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE project_id = ?").get(access.projectId) as { m: number }).m;
    return sse(c, ctx, {
      topics: [`project:${access.projectId}`],
      cursor: resumeCursor(c, latest),
      eventName: "event",
      authorize: () => {
        try {
          if (agent ? !clientStillValid(ctx, agent.clientId) : !sessionId || !sessionStillValid(ctx, sessionId)) return false;
          const now = projectAccess(ctx, actor.userId, access.projectId);
          if (agent) requireAgentPermission(agent, now.role, "project.read");
          return true;
        } catch {
          return false;
        }
      },
      // Role is re-read on every fetch so a downgrade or restriction change applies to the open stream.
      fetch: (cursor) => {
        const role = projectAccess(ctx, actor.userId, access.projectId).role;
        return { items: listEvents(ctx, access.projectId, cursor, MAX_EVENT_PAGE, { userId: actor.userId, role }).events, cursorOf: (e: EventView) => e.seq };
      },
      onDelivered: (seq) => markStreamDelivered(ctx, consumer, access.projectId, seq),
    });
  });

  // Consumers confirm what they processed; the stored cursor never moves backwards.
  r.get("/:id/cursor", (c) => {
    const { actor, access } = actorFor(ctx, c);
    return c.json({ last_seen_seq: readCursor(ctx, consumerOf(actor), access.projectId) });
  });

  r.post("/:id/cursor", async (c) => {
    const { actor, access } = actorFor(ctx, c);
    const body = (await c.req.json().catch(() => null)) as { seq?: unknown } | null;
    if (!body || typeof body.seq !== "number" || !Number.isInteger(body.seq) || body.seq < 0) throw invalid("seq must be a non-negative integer");
    return c.json({ last_seen_seq: ackCursor(ctx, consumerOf(actor), access.projectId, body.seq) });
  });

  return r;
}
