import type { UserView } from "@coagents/contract";
import { audit } from "./audit.js";
import { nowIso, type AppContext } from "./context.js";
import { HttpError, notFound } from "./http-error.js";
import { newId } from "./ids.js";
import { getSetting } from "./instance.js";
import { hashPassword, verifyPassword } from "./passwords.js";

export interface Application {
  username: string;
  display_name: string;
  password: string;
  timezone: string;
  email: string;
  note: string;
}

// Anyone may apply; nothing is granted until a maintainer approves. The username is reserved while
// the application is pending, and must not already belong to an account.
export async function apply(ctx: AppContext, a: Application): Promise<{ status: "pending" }> {
  if (getSetting(ctx, "registration_mode") === "closed") {
    throw new HttpError(403, "registration_closed", "Registration is closed on this instance; ask an administrator or a project owner for an invitation");
  }
  const taken = ctx.db.prepare("SELECT 1 FROM users WHERE username = ? UNION SELECT 1 FROM registrations WHERE username = ? AND status = 'pending'").get(a.username, a.username);
  if (taken) throw new HttpError(409, "username_taken", "Username is already taken");
  const hash = await hashPassword(a.password);
  const id = newId("reg");
  ctx.db
    .prepare(
      `INSERT INTO registrations (id, username, display_name, email, note, timezone, password_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(id, a.username, a.display_name, a.email, a.note, a.timezone, hash, nowIso(ctx));
  audit(ctx, { projectId: null, actorUserId: null, action: "registration.submit", objectType: "registration", objectId: id, detail: { username: a.username } });
  return { status: "pending" };
}

// For sign-in: tell an applicant with the right password where their application stands. A wrong
// password gets the ordinary "wrong username or password", so applications cannot be probed.
export async function applicationState(ctx: AppContext, username: string, password: string): Promise<"pending" | "rejected" | null> {
  const r = ctx.db
    .prepare("SELECT status, password_hash FROM registrations WHERE username = ? AND status IN ('pending', 'rejected') ORDER BY created_at DESC LIMIT 1")
    .get(username) as { status: "pending" | "rejected"; password_hash: string } | undefined;
  if (!r || !(await verifyPassword(r.password_hash, password))) return null;
  return r.status;
}

export interface RegistrationView {
  id: string;
  username: string;
  display_name: string;
  email: string;
  note: string;
  timezone: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  decided_at: string | null;
  decided_by_username: string | null;
  decision_note: string | null;
}

export function listRegistrations(ctx: AppContext, status: string | undefined): RegistrationView[] {
  return ctx.db
    .prepare(
      `SELECT r.id, r.username, r.display_name, r.email, r.note, r.timezone, r.status, r.created_at, r.decided_at, u.username AS decided_by_username, r.decision_note
       FROM registrations r LEFT JOIN users u ON u.id = r.decided_by
       ${status ? "WHERE r.status = ?" : ""} ORDER BY r.created_at DESC LIMIT 200`,
    )
    .all(...(status ? [status] : [])) as RegistrationView[];
}

export function decide(ctx: AppContext, id: string, actorId: string, approve: boolean, note: string | undefined): UserView | null {
  return ctx.db.transaction(() => {
    const r = ctx.db.prepare("SELECT * FROM registrations WHERE id = ? AND status = 'pending'").get(id) as
      | { username: string; display_name: string; email: string; timezone: string; password_hash: string }
      | undefined;
    if (!r) throw notFound();
    const now = nowIso(ctx);
    let userId: string | null = null;
    if (approve) {
      if (ctx.db.prepare("SELECT 1 FROM users WHERE username = ?").get(r.username)) throw new HttpError(409, "username_taken", "Username was taken in the meantime; reject this application");
      userId = newId("usr");
      ctx.db
        .prepare(
          `INSERT INTO users (id, username, display_name, timezone, password_hash, instance_role, created_at, email)
           VALUES (?, ?, ?, ?, ?, 'member', ?, ?)`,
        )
        .run(userId, r.username, r.display_name, r.timezone, r.password_hash, now, r.email);
    }
    ctx.db
      .prepare("UPDATE registrations SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, user_id = ? WHERE id = ?")
      .run(approve ? "approved" : "rejected", actorId, now, note ?? null, userId, id);
    audit(ctx, { projectId: null, actorUserId: actorId, action: approve ? "registration.approve" : "registration.reject", objectType: "registration", objectId: id, detail: { username: r.username } });
    return userId ? (ctx.db.prepare("SELECT id, username, display_name, timezone, instance_role FROM users WHERE id = ?").get(userId) as UserView) : null;
  })();
}
