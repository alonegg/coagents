import type { SessionView, UserView } from "@coagents/contract";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { nowIso, type AppContext } from "./context.js";
import { HttpError } from "./http-error.js";
import { wakeAuthChanged } from "./bus.js";
import { hashSecret, newId, newSecret } from "./ids.js";

export const SESSION_COOKIE = "coagents_session";
export const DEVICE_COOKIE = "coagents_device";
const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 3600;
const LAST_SEEN_RESOLUTION_MS = 60_000;

export interface AuthState {
  user: UserView;
  sessionId: string;
  deviceId: string;
  csrfToken: string;
}

export type Env = { Variables: { auth: AuthState | null; agent: import("./agents.js").AgentState | null } };

interface SessionRow {
  session_id: string;
  csrf_token: string;
  expires_at: string;
  device_id: string;
  device_last_seen: string;
  id: string;
  username: string;
  display_name: string;
  timezone: string;
  instance_role: "maintainer" | "member";
  must_change_password: number;
}

// Resolves the browser session cookie. A session is valid only while the session, its device
// and its user are all active, so revoking any of them takes effect on the next request.
export function sessionMiddleware(ctx: AppContext): MiddlewareHandler<Env> {
  return async (c, next) => {
    c.set("auth", null);
    const token = getCookie(c, SESSION_COOKIE);
    // A bearer (agent) request never also acts as a browser session.
    if (token && !c.req.header("authorization")) {
      const now = nowIso(ctx);
      const row = ctx.db
        .prepare(
          `SELECT s.id AS session_id, s.csrf_token, s.expires_at, d.id AS device_id, d.last_seen_at AS device_last_seen,
                  u.id, u.username, u.display_name, u.timezone, u.instance_role, u.must_change_password
           FROM sessions s JOIN devices d ON d.id = s.device_id JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
             AND d.revoked_at IS NULL AND u.auth_state = 'active'`,
        )
        .get(hashSecret(token), now) as SessionRow | undefined;
      if (row) {
        c.set("auth", {
          user: {
            id: row.id,
            username: row.username,
            display_name: row.display_name,
            timezone: row.timezone,
            instance_role: row.instance_role,
            must_change_password: row.must_change_password === 1,
          },
          sessionId: row.session_id,
          deviceId: row.device_id,
          csrfToken: row.csrf_token,
        });
        if (Date.parse(now) - Date.parse(row.device_last_seen) > LAST_SEEN_RESOLUTION_MS) {
          ctx.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, row.device_id);
        }
      }
    }
    await next();
  };
}

export function requireAuth(c: Context<Env>): AuthState {
  const auth = c.get("auth");
  if (!auth) throw new HttpError(401, "unauthenticated", "Sign in required");
  return auth;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Cookie-authenticated writes must carry the session's CSRF token and, when the browser sends
// an Origin, come from the configured public origin.
export function csrfMiddleware(ctx: AppContext): MiddlewareHandler<Env> {
  const expectedOrigin = new URL(ctx.config.publicUrl).origin;
  return async (c, next) => {
    const auth = c.get("auth");
    if (auth && !SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== undefined && origin !== expectedOrigin) {
        throw new HttpError(403, "csrf_failed", "Cross-origin request rejected");
      }
      if (c.req.header("x-csrf-token") !== auth.csrfToken) {
        throw new HttpError(403, "csrf_failed", "Missing or invalid CSRF token");
      }
    }
    await next();
  };
}

function secureCookies(ctx: AppContext): boolean {
  return ctx.config.publicUrl.startsWith("https://");
}

// Reuses this browser's device record when it belongs to the same user; otherwise registers a new one.
function resolveBrowserDevice(ctx: AppContext, c: Context<Env>, userId: string): string {
  const now = nowIso(ctx);
  const existing = getCookie(c, DEVICE_COOKIE);
  if (existing) {
    const row = ctx.db
      .prepare("SELECT id FROM devices WHERE token_hash = ? AND user_id = ? AND kind = 'browser' AND revoked_at IS NULL")
      .get(hashSecret(existing), userId) as { id: string } | undefined;
    if (row) return row.id;
  }
  const token = newSecret();
  const id = newId("dev");
  const label = (c.req.header("user-agent") ?? "Browser").slice(0, 120);
  ctx.db
    .prepare(
      "INSERT INTO devices (id, user_id, kind, label, token_hash, created_at, last_seen_at) VALUES (?, ?, 'browser', ?, ?, ?, ?)",
    )
    .run(id, userId, label, hashSecret(token), now, now);
  setCookie(c, DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(ctx),
    sameSite: "Lax",
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE,
  });
  return id;
}

export function startSession(ctx: AppContext, c: Context<Env>, user: UserView): SessionView {
  const deviceId = resolveBrowserDevice(ctx, c, user.id);
  const token = newSecret();
  const csrfToken = newSecret();
  const now = ctx.clock();
  const expires = new Date(now.getTime() + ctx.config.sessionTtlHours * 3600_000);
  ctx.db
    .prepare(
      "INSERT INTO sessions (id, token_hash, user_id, device_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(newId("ses"), hashSecret(token), user.id, deviceId, csrfToken, now.toISOString(), expires.toISOString());
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(ctx),
    sameSite: "Lax",
    path: "/",
    maxAge: ctx.config.sessionTtlHours * 3600,
  });
  return { user, device_id: deviceId, csrf_token: csrfToken };
}

export function endSession(ctx: AppContext, c: Context<Env>, sessionId: string): void {
  ctx.db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(ctx), sessionId);
  wakeAuthChanged();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secureCookies(ctx) });
}

// Fixed-window limiter on failed logins per username; in memory because the service is single-instance.
export class LoginLimiter {
  private failures = new Map<string, { count: number; windowStart: number }>();
  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60_000,
  ) {}

  check(key: string, now: number): void {
    const f = this.failures.get(key);
    if (f && now - f.windowStart < this.windowMs && f.count >= this.maxFailures) {
      throw new HttpError(429, "rate_limited", "Too many failed sign-in attempts; try again later");
    }
  }

  fail(key: string, now: number): void {
    const f = this.failures.get(key);
    if (!f || now - f.windowStart >= this.windowMs) this.failures.set(key, { count: 1, windowStart: now });
    else f.count++;
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}

// Used by long-lived streams to re-check a session on every delivery.
export function sessionStillValid(ctx: AppContext, sessionId: string): boolean {
  return (
    ctx.db
      .prepare(
        `SELECT 1 FROM sessions s JOIN devices d ON d.id = s.device_id JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND d.revoked_at IS NULL AND u.auth_state = 'active'`,
      )
      .get(sessionId, nowIso(ctx)) !== undefined
  );
}

// A session holding a temporary password may only change it (and read or end the session).
export function passwordChangeGate(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (auth?.user.must_change_password) {
      const p = c.req.path;
      const allowed = p.endsWith("/session") || p.endsWith("/session/password") || p.endsWith("/health") || p.endsWith("/instance");
      if (!allowed) throw new HttpError(403, "password_change_required", "Set a new password before continuing");
    }
    await next();
  };
}
