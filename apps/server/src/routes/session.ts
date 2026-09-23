import { ChangePasswordInput, LoginInput } from "@coagents/contract";
import { audit } from "../audit.js";
import { nowIso } from "../context.js";
import { applicationState } from "../registrations.js";
import { Hono } from "hono";
import { endSession, requireAuth, startSession, type Env, type LoginLimiter } from "../auth.js";
import type { AppContext } from "../context.js";
import { HttpError } from "../http-error.js";
import { burnPasswordCheck, verifyPassword } from "../passwords.js";
import { changeOwnPassword, findUserForLogin } from "../users.js";
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
      if (!user) {
        const state = await applicationState(ctx, input.username, input.password);
        if (state === "pending") throw new HttpError(403, "registration_pending", "Your registration is waiting for an administrator's approval");
        if (state === "rejected") throw new HttpError(403, "registration_rejected", "Your registration was not approved; contact the administrator");
      } else {
        audit(ctx, { projectId: null, actorUserId: null, action: "login.failed", objectType: "user", objectId: user.id, detail: { reason: ok ? "disabled" : "password" } });
      }
      throw new HttpError(401, "unauthenticated", "Wrong username or password");
    }
    limiter.succeed(input.username);
    ctx.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(ctx), user.id);
    const { password_hash: _h, auth_state: _s, ...view } = user;
    return c.json(startSession(ctx, c, { ...view, must_change_password: Boolean(view.must_change_password) }), 201);
  });

  r.get("/", (c) => {
    const auth = requireAuth(c);
    return c.json({ user: auth.user, device_id: auth.deviceId, csrf_token: auth.csrfToken });
  });

  r.put("/password", async (c) => {
    const auth = requireAuth(c);
    const input = await parseBody(c, ChangePasswordInput);
    await changeOwnPassword(ctx, auth.user.id, auth.sessionId, input.current_password, input.new_password);
    audit(ctx, { projectId: null, actorUserId: auth.user.id, action: "user.password_change", objectType: "user", objectId: auth.user.id });
    return c.body(null, 204);
  });

  r.delete("/", (c) => {
    const auth = requireAuth(c);
    endSession(ctx, c, auth.sessionId);
    return c.body(null, 204);
  });

  return r;
}
