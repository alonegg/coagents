import type { ErrorBody } from "@coagents/contract";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { csrfMiddleware, LoginLimiter, sessionMiddleware, type Env } from "./auth.js";
import type { AppContext } from "./context.js";
import { schemaVersion } from "./db.js";
import { HttpError } from "./http-error.js";
import { deviceRoutes } from "./routes/devices.js";
import { invitationRoutes } from "./routes/invitations.js";
import { projectRoutes } from "./routes/projects.js";
import { sessionRoutes } from "./routes/session.js";
import { workRoutes } from "./routes/work.js";

export const SERVER_VERSION = "0.1.0";

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
  api.use("*", csrfMiddleware(ctx));

  api.get("/health", (c) => c.json({ status: "ok", version: SERVER_VERSION, schema_version: schemaVersion(ctx.db) }));
  api.route("/session", sessionRoutes(ctx, new LoginLimiter()));
  api.route("/projects", projectRoutes(ctx));
  api.route("/projects", workRoutes(ctx));
  api.route("/invitations", invitationRoutes(ctx));
  api.route("/devices", deviceRoutes(ctx));
  return api;
}

export function createApp(ctx: AppContext, hub?: Hono): Hono {
  const app = new Hono();
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
      referrerPolicy: "no-referrer",
    }),
  );
  app.route("/v1", createApi(ctx));
  if (hub) app.route("/", hub);
  return app;
}
