import { AcceptHandoffInput, PrepareHandoffInput } from "@coagents/contract";
import { Hono, type Context } from "hono";
import { requireActive } from "../access.js";
import type { Env } from "../auth.js";
import type { AppContext } from "../context.js";
import { cancelHandoff, checkHandoff, completeHandoff, getHandoff, listHandoffs, prepareHandoff } from "../handoffs.js";
import { idempotent, priorResult } from "../idempotency.js";
import { parseBody } from "../validate.js";
import { actorFor, checkPermission } from "./work.js";

export function handoffRoutes(ctx: AppContext): Hono<Env> {
  const r = new Hono<Env>();

  function resolve(c: Context<Env>, write: boolean) {
    const x = actorFor(ctx, c);
    if (write) {
      checkPermission(x, "task.write");
      requireActive(x.access);
    }
    return { ...x, viewer: { userId: x.actor.userId, role: x.access.role } };
  }

  r.get("/:id/handoffs", (c) => {
    const { access, viewer } = resolve(c, false);
    return c.json({ handoffs: listHandoffs(ctx, access.projectId, viewer, { state: c.req.query("state"), taskId: c.req.query("task_id") }) });
  });

  r.get("/:id/handoffs/:hid", (c) => {
    const { access, viewer } = resolve(c, false);
    return c.json(getHandoff(ctx, access.projectId, viewer, c.req.param("hid")));
  });

  r.post("/:id/tasks/:taskId/handoffs", async (c) => {
    const input = await parseBody(c, PrepareHandoffInput);
    const { actor, access, viewer } = resolve(c, true);
    const { request_id, ...rest } = input;
    const res = idempotent(ctx, actor, request_id, `handoff.prepare:${c.req.param("taskId")}`, () => ({
      status: 201,
      body: prepareHandoff(ctx, access.projectId, actor, viewer, c.req.param("taskId"), rest),
    }));
    return c.json(res.body as object, res.status);
  });

  r.post("/:id/handoffs/:hid/accept", async (c) => {
    const input = await parseBody(c, AcceptHandoffInput);
    const { actor, access, viewer } = resolve(c, true);
    const hid = c.req.param("hid");
    const scope = `handoff.accept:${hid}`;
    const prior = priorResult(ctx, actor, input.request_id, scope);
    if (prior) return c.json(prior.body as object, prior.status);
    checkHandoff(ctx, access.projectId, actor, viewer, hid, input.check);
    const res = idempotent(ctx, actor, input.request_id, scope, () => ({ status: 200, body: completeHandoff(ctx, access.projectId, actor, viewer, hid) }));
    return c.json(res.body as object, res.status);
  });

  r.post("/:id/handoffs/:hid/cancel", (c) => {
    const { actor, access, viewer } = resolve(c, true);
    return c.json(cancelHandoff(ctx, access.projectId, actor, viewer, c.req.param("hid")));
  });

  return r;
}
