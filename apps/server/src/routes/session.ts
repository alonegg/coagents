import { LoginInput } from "@coagents/contract";
import { Hono } from "hono";
import { endSession, requireAuth, startSession, type Env, type LoginLimiter } from "../auth.js";
import type { AppContext } from "../context.js";
import { HttpError } from "../http-error.js";
import { burnPasswordCheck, verifyPassword } from "../passwords.js";
import { findUserForLogin } from "../users.js";
import { parseBody } from "../validate.js";

export function sessionRoutes(ctx: AppContext, limiter: LoginLimiter): Hono<Env> {
  const r = new Hono<Env>();

  r.post("/", async (c) => {
    const input = await parseBody(c, LoginInput);
    const now = ctx.clock().getTime();
    limiter.check(input.username, now);
    const user = findUserForLogin(ctx, input.username);
    const ok = user ? await verifyPassword(user.password_hash, input.password) : (await burnPasswordCheck(input.password), false);
    if (!user || !ok || user.auth_state !== "active") {
      limiter.fail(input.username, now);
      throw new HttpError(401, "unauthenticated", "Wrong username or password");
    }
    limiter.succeed(input.username);
    const { password_hash: _h, auth_state: _s, ...view } = user;
    return c.json(startSession(ctx, c, view), 201);
  });

  r.get("/", (c) => {
    const auth = requireAuth(c);
    return c.json({ user: auth.user, device_id: auth.deviceId, csrf_token: auth.csrfToken });
  });

  r.delete("/", (c) => {
    const auth = requireAuth(c);
    endSession(ctx, c, auth.sessionId);
    return c.body(null, 204);
  });

  return r;
}
