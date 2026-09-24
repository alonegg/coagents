import { AI_NOTICE } from "@coagents/contract";
import { Hono } from "hono";
import { z } from "zod";
import { requireActive, requirePermission } from "../access.js";
import { aiAvailable, aiConfig, briefingKey, DIGEST_HOURS, digestKey, latestOutput, projectAiEnabled, startBriefing, startDigest, startPrereview } from "../ai.js";
import { audit } from "../audit.js";
import type { Env } from "../auth.js";
import type { AppContext } from "../context.js";
import { invalid, notAllowed, notFound } from "../http-error.js";
import { parseBody } from "../validate.js";
import { actorFor, checkPermission } from "./work.js";

const ProjectAiInput = z.object({ enabled: z.boolean() }).strict();
const DigestInput = z.object({ hours: z.number().int().optional() }).strict();

function hoursOf(v: unknown): number {
  const h = v === undefined ? 24 : Number(v);
  if (!(DIGEST_HOURS as readonly number[]).includes(h)) throw invalid(`hours must be one of ${DIGEST_HOURS.join(", ")}`);
  return h;
}

// Advisory model output. Reading is open to every member and agent that can read the project;
// starting a model call needs task.write (it costs quota); re-running a pre-review needs task.review.
export function aiRoutes(ctx: AppContext): Hono<Env> {
  const r = new Hono<Env>();

  r.get("/:id/ai", (c) => {
    const { access } = actorFor(ctx, c);
    return c.json({ available: aiAvailable(ctx, access.projectId), instance_enabled: aiConfig(ctx) !== null, project_enabled: projectAiEnabled(ctx, access.projectId), notice: AI_NOTICE });
  });

  r.put("/:id/ai", async (c) => {
    const resolved = actorFor(ctx, c);
    if (resolved.agent) throw notAllowed("Only a person can change project settings");
    requirePermission(resolved.access, "milestone.manage");
    requireActive(resolved.access);
    const input = await parseBody(c, ProjectAiInput);
    ctx.db.prepare("UPDATE projects SET ai_enabled = ? WHERE id = ?").run(input.enabled ? 1 : 0, resolved.access.projectId);
    audit(ctx, { projectId: resolved.access.projectId, actorUserId: resolved.actor.userId, action: "project.ai", objectType: "project", objectId: resolved.access.projectId, detail: { enabled: input.enabled } });
    return c.json({ available: aiAvailable(ctx, resolved.access.projectId), instance_enabled: aiConfig(ctx) !== null, project_enabled: input.enabled, notice: AI_NOTICE });
  });

  r.get("/:id/tasks/:taskId/ai", (c) => {
    const { access } = actorFor(ctx, c);
    const taskId = c.req.param("taskId");
    const latest = ctx.db.prepare("SELECT id FROM task_submissions WHERE task_id = ? AND task_id IN (SELECT id FROM tasks WHERE project_id = ?) ORDER BY created_at DESC LIMIT 1").get(taskId, access.projectId) as { id: string } | undefined;
    let key: string;
    try {
      key = briefingKey(ctx, access.projectId, taskId);
    } catch {
      throw notFound();
    }
    return c.json({
      available: aiAvailable(ctx, access.projectId),
      notice: AI_NOTICE,
      prereview: latest ? latestOutput(ctx, access.projectId, "prereview", latest.id) : null,
      prereview_submission_id: latest?.id ?? null,
      briefing: latestOutput(ctx, access.projectId, "briefing", taskId, key),
    });
  });

  r.post("/:id/tasks/:taskId/ai/briefing", (c) => {
    const resolved = actorFor(ctx, c);
    checkPermission(resolved, "task.write");
    return c.json(startBriefing(ctx, resolved.access.projectId, c.req.param("taskId"), resolved.actor.userId), 202);
  });

  r.post("/:id/tasks/:taskId/ai/prereview", (c) => {
    const resolved = actorFor(ctx, c);
    if (resolved.agent) throw notAllowed("Pre-review is for the people who review tasks");
    requirePermission(resolved.access, "task.review");
    const taskId = c.req.param("taskId");
    const latest = ctx.db.prepare("SELECT s.id FROM task_submissions s JOIN tasks t ON t.id = s.task_id WHERE s.task_id = ? AND t.project_id = ? ORDER BY s.created_at DESC LIMIT 1").get(taskId, resolved.access.projectId) as { id: string } | undefined;
    if (!latest) throw invalid("This task has no submission yet");
    return c.json(startPrereview(ctx, resolved.access.projectId, taskId, latest.id, resolved.actor.userId), 202);
  });

  r.get("/:id/ai/digest", (c) => {
    const { access } = actorFor(ctx, c);
    const hours = hoursOf(c.req.query("hours"));
    return c.json({
      available: aiAvailable(ctx, access.projectId),
      notice: AI_NOTICE,
      digest: latestOutput(ctx, access.projectId, "digest", `${access.projectId}:${hours}h`, digestKey(ctx, access.projectId, hours)),
    });
  });

  r.post("/:id/ai/digest", async (c) => {
    const resolved = actorFor(ctx, c);
    checkPermission(resolved, "task.write");
    const input = await parseBody(c, DigestInput);
    return c.json(startDigest(ctx, resolved.access.projectId, hoursOf(input.hours), resolved.actor.userId), 202);
  });

  return r;
}
