import { Hono } from "hono";
import { requireAuth, type Env } from "../auth.js";
import type { AppContext } from "../context.js";
import { invalid } from "../http-error.js";
import { crossProjectActivity } from "../summaries.js";

export function activityRoutes(ctx: AppContext): Hono<Env> {
  const r = new Hono<Env>();
  r.get("/", (c) => {
    const auth = requireAuth(c);
    const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    if ((before !== undefined && !Number.isInteger(before)) || !Number.isInteger(limit) || limit < 1) throw invalid("Bad paging");
    return c.json(
      crossProjectActivity(ctx, auth.user.id, {
        before,
        projectId: c.req.query("project_id"),
        kind: c.req.query("kind"),
        actorUserId: c.req.query("actor"),
        limit,
      }),
    );
  });
  return r;
}
