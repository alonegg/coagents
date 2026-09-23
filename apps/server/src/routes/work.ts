import {
  CreateTaskInput,
  DecisionInput,
  EditTaskInput,
  HttpBlockerInput,
  HttpClaimInput,
  HttpReleaseInput,
  HttpRenewInput,
  HttpSubmitInput,
  ReasonedReviewInput,
  ReviewInput,
  TaskStatus,
  type Permission,
} from "@coagents/contract";
import { Hono, type Context } from "hono";
import { projectAccess, requireActive, requirePermission, type ProjectAccess } from "../access.js";
import { requireAuth, type Env } from "../auth.js";
import type { Actor, AppContext } from "../context.js";
import { listDecisions, publishDecision, publishGeneralBlocker } from "../decisions.js";
import { ackCursor, listEvents, MAX_EVENT_PAGE, readCursor } from "../events.js";
import { invalid, notAllowed, notFound } from "../http-error.js";
import { requireAgentPermission, type AgentState } from "../agents.js";
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
export function actorFor(ctx: AppContext, c: Context<Env>): { actor: Actor; access: ProjectAccess; agent: AgentState | null } {
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

function checkPermission(ctx: { access: ProjectAccess; agent: AgentState | null }, permission: Permission): void {
  if (ctx.agent) requireAgentPermission(ctx.agent, ctx.access.role, permission);
  else requirePermission(ctx.access, permission);
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
    const { access } = actorFor(ctx, c);
    const task = getTask(ctx, access.projectId, c.req.param("taskId"));
    return c.json({ ...task, submissions: listSubmissions(ctx, task.id) });
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
      if (resolved.agent) throw notAllowed("Agents cannot review tasks; a person must do this in the Hub");
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
    return write(c, input, "blocker", (actor, access) => {
      if (input.task_id) {
        return { status: 201, body: blockTask(ctx, access.projectId, actor, input.task_id, input.lease_token, input.body) };
      }
      if (input.lease_token) throw invalid("lease_token needs task_id");
      return { status: 201, body: { event_seq: publishGeneralBlocker(ctx, access.projectId, actor, input.body), task: null } };
    });
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
    const { access } = actorFor(ctx, c);
    const cursor = Number(c.req.query("cursor") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 50), MAX_EVENT_PAGE);
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1) throw invalid("Bad cursor or limit");
    return c.json(listEvents(ctx, access.projectId, cursor, limit));
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
