import type { ErrorBody } from "@coagents/contract";
import { Hono } from "hono";
import { csrfMiddleware, LoginLimiter, passwordChangeGate, sessionMiddleware, type Env } from "./auth.js";
import { ApplyInput } from "@coagents/contract";
import { settings } from "./instance.js";
import { apply } from "./registrations.js";
import { parseBody } from "./validate.js";
import { adminRoutes } from "./routes/admin.js";
import type { AppContext } from "./context.js";
import { schemaVersion } from "./db.js";
import { HttpError } from "./http-error.js";
import { deviceRoutes } from "./routes/devices.js";
import { invitationRoutes } from "./routes/invitations.js";
import { projectRoutes } from "./routes/projects.js";
import { sessionRoutes } from "./routes/session.js";
import { workRoutes } from "./routes/work.js";
import { agentRoutes } from "./routes/agents.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { handoffRoutes } from "./routes/handoffs.js";
import { planningRoutes } from "./routes/planning.js";
import { aiRoutes } from "./routes/ai.js";
import { activityRoutes } from "./routes/activity.js";
import { notificationRoutes } from "./routes/notifications.js";
import { agentMiddleware } from "./agents.js";

export const SERVER_VERSION = "0.1.0";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export function createApi(ctx: AppContext): Hono<Env> {
  const api = new Hono<Env>();

  api.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json<ErrorBody>({ error: { code: err.code, message: err.message } }, err.status);
    }
    console.error(err);
    return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
  });
  api.notFound((c) => c.json<ErrorBody>({ error: { code: "forbidden_or_not_found", message: "Not found" } }, 404));

  api.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  api.use("*", sessionMiddleware(ctx));
  api.use("*", agentMiddleware(ctx));
  api.use("*", csrfMiddleware(ctx));
  api.use("*", passwordChangeGate());

  // Public: what the landing page needs to know about this instance.
  api.get("/instance", (c) => c.json({ ...settings(ctx), version: SERVER_VERSION }));

  const applyLimiter = new LoginLimiter(5, 3600_000);
  api.post("/registrations", async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    applyLimiter.check(ip, ctx.clock().getTime());
    const input = await parseBody(c, ApplyInput);
    applyLimiter.fail(ip, ctx.clock().getTime());
    return c.json(await apply(ctx, input), 201);
  });

  api.get("/health", (c) =>
    c.json({ status: "ok", version: SERVER_VERSION, schema_version: schemaVersion(ctx.db), ...(ctx.config.build ? { build: ctx.config.build } : {}) }),
  );
  api.route("/session", sessionRoutes(ctx, new LoginLimiter()));
  api.route("/projects", projectRoutes(ctx));
  api.route("/projects", workRoutes(ctx));
  api.route("/projects", artifactRoutes(ctx));
  api.route("/projects", handoffRoutes(ctx));
  api.route("/projects", planningRoutes(ctx));
  api.route("/projects", aiRoutes(ctx));
  api.route("/invitations", invitationRoutes(ctx));
  api.route("/devices", deviceRoutes(ctx));
  api.route("/notifications", notificationRoutes(ctx));
  api.route("/activity", activityRoutes(ctx));
  api.route("/admin", adminRoutes(ctx));
  api.route("/", agentRoutes(ctx));
  return api;
}

export function createApp(ctx: AppContext, hub?: Hono): Hono {
  const app = new Hono();
  // Security headers for every response; a route may set a stricter value (file downloads do).
  app.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  });
  app.route("/v1", createApi(ctx));
  if (hub) app.route("/", hub);
  return app;
}
