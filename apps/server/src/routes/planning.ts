import { CreateMilestoneInput, DueChangeInput, DueInput, EditMilestoneInput, MilestoneDecisionInput, MilestoneScopeInput } from "@coagents/contract";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireActive } from "../access.js";
import type { Env } from "../auth.js";
import type { AppContext } from "../context.js";
import { invalid } from "../http-error.js";
import { idempotent } from "../idempotency.js";
import { achieveMilestone, changeScope, createMilestone, editMilestone, getMilestone, listMilestones, reopenMilestone, setProjectDue, setTaskDue } from "../milestones.js";
import { searchArtifacts } from "../search.js";
import { getTask } from "../tasks.js";
import { parseBody } from "../validate.js";
import { actorFor, checkPermission } from "./work.js";
import type { Permission } from "@coagents/contract";

export function planningRoutes(ctx: AppContext): Hono<Env> {
  const r = new Hono<Env>();

  function writer(c: Context<Env>, permission: Permission) {
    const x = actorFor(ctx, c);
    checkPermission(x, permission);
    requireActive(x.access);
    return x;
  }

  function write(c: Context<Env>, permission: Permission, requestId: string, scope: string, status: 200 | 201, fn: (x: ReturnType<typeof writer>) => unknown) {
    const x = writer(c, permission);
    const res = idempotent(ctx, x.actor, requestId, `${scope}:${x.access.projectId}`, () => ({ status, body: fn(x) }));
    return c.json(res.body as object, res.status);
  }

  r.get("/:id/milestones", (c) => {
    const { access } = actorFor(ctx, c);
    return c.json({ milestones: listMilestones(ctx, access.projectId) });
  });

  r.get("/:id/milestones/:mid", (c) => {
    const { access } = actorFor(ctx, c);
    return c.json(getMilestone(ctx, access.projectId, c.req.param("mid")));
  });

  r.post("/:id/milestones", async (c) => {
    const input = await parseBody(c, CreateMilestoneInput);
    return write(c, "milestone.manage", input.request_id, "milestone.create", 201, (x) => createMilestone(ctx, x.access.projectId, x.actor, input));
  });

  r.patch("/:id/milestones/:mid", async (c) => {
    const input = await parseBody(c, EditMilestoneInput);
    const { expected_version, request_id, ...patch } = input;
    return write(c, "milestone.manage", request_id, `milestone.edit:${c.req.param("mid")}`, 200, (x) => editMilestone(ctx, x.access.projectId, x.actor, c.req.param("mid"), expected_version, patch));
  });

  r.post("/:id/milestones/:mid/scope", async (c) => {
    const input = await parseBody(c, MilestoneScopeInput);
    return write(c, "milestone.manage", input.request_id, `milestone.scope:${c.req.param("mid")}`, 200, (x) =>
      changeScope(ctx, x.access.projectId, x.actor, c.req.param("mid"), input.expected_version, input.add_task_ids, input.remove_task_ids, input.reason),
    );
  });

  r.post("/:id/milestones/:mid/achieve", async (c) => {
    const input = await parseBody(c, MilestoneDecisionInput);
    return write(c, "milestone.manage", input.request_id, `milestone.achieve:${c.req.param("mid")}`, 200, (x) =>
      achieveMilestone(ctx, x.access.projectId, x.actor, c.req.param("mid"), input.expected_version, input.note),
    );
  });

  r.post("/:id/milestones/:mid/reopen", async (c) => {
    const input = await parseBody(c, MilestoneDecisionInput);
    return write(c, "milestone.manage", input.request_id, `milestone.reopen:${c.req.param("mid")}`, 200, (x) =>
      reopenMilestone(ctx, x.access.projectId, x.actor, c.req.param("mid"), input.expected_version, input.note),
    );
  });

  r.put("/:id/tasks/:taskId/due", async (c) => {
    const input = await parseBody(c, DueChangeInput);
    return write(c, "task.write", input.request_id, `task.due:${c.req.param("taskId")}`, 200, (x) => {
      setTaskDue(ctx, x.access.projectId, x.actor, c.req.param("taskId"), input.expected_version, input.due_at);
      return getTask(ctx, x.access.projectId, c.req.param("taskId"));
    });
  });

  r.put("/:id/due", async (c) => {
    const input = await parseBody(c, z.object({ due_at: DueInput, request_id: z.string().min(8).max(128) }).strict());
    return write(c, "milestone.manage", input.request_id, "project.due", 200, (x) => ({ due_at: setProjectDue(ctx, x.access.projectId, x.actor, input.due_at) }));
  });

  r.get("/:id/search", (c) => {
    const { actor, access } = actorFor(ctx, c);
    const q = c.req.query("q") ?? "";
    if (q.length > 200) throw invalid("Query is too long");
    const limit = Math.min(Number(c.req.query("limit") ?? 20), 50);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
    if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1) throw invalid("Bad paging");
    return c.json(searchArtifacts(ctx, access.projectId, { userId: actor.userId, role: access.role }, q, { scope: c.req.query("scope") === "all" ? "all" : "current", limit, offset }));
  });

  return r;
}
