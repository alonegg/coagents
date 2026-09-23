import type { UserView } from "@coagents/contract";
import { nowIso, type AppContext } from "./context.js";
import { HttpError } from "./http-error.js";
import { wakeAuthChanged } from "./bus.js";
import { newId } from "./ids.js";
import { hashPassword } from "./passwords.js";

export interface NewUser {
  username: string;
  displayName: string;
  timezone: string;
  password: string;
  instanceRole: "maintainer" | "member";
}

const USER_COLUMNS = "id, username, display_name, timezone, instance_role";

export async function createUser(ctx: AppContext, u: NewUser): Promise<UserView> {
  const passwordHash = await hashPassword(u.password);
  const id = newId("usr");
  try {
    ctx.db
      .prepare(
        `INSERT INTO users (id, username, display_name, timezone, password_hash, instance_role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, u.username, u.displayName, u.timezone, passwordHash, u.instanceRole, nowIso(ctx));
  } catch (err) {
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new HttpError(409, "username_taken", "Username is already taken");
    }
    throw err;
  }
  return getUser(ctx, id)!;
}

export function getUser(ctx: AppContext, id: string): UserView | undefined {
  return ctx.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as UserView | undefined;
}

export function findUserForLogin(
  ctx: AppContext,
  username: string,
): (UserView & { password_hash: string; auth_state: string }) | undefined {
  return ctx.db
    .prepare(`SELECT ${USER_COLUMNS}, password_hash, auth_state FROM users WHERE username = ?`)
    .get(username) as (UserView & { password_hash: string; auth_state: string }) | undefined;
}

// Instance maintainers reset passwords from the server host; every session of that user ends.
export async function resetPassword(ctx: AppContext, username: string, password: string): Promise<UserView> {
  const user = findUserForLogin(ctx, username);
  if (!user) throw new HttpError(404, "forbidden_or_not_found", `No user named ${username}`);
  const passwordHash = await hashPassword(password);
  const now = nowIso(ctx);
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
    ctx.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, user.id);
  })();
  wakeAuthChanged();
  return getUser(ctx, user.id)!;
}

export function userCount(ctx: AppContext): number {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

// Instance maintainers disable an account from the server host: sign-in stops, every session and
// agent connection ends at once, and leases it holds lapse. Project data it created stays.
export function disableUser(ctx: AppContext, username: string): UserView {
  const user = findUserForLogin(ctx, username);
  if (!user) throw new HttpError(404, "forbidden_or_not_found", `No user named ${username}`);
  const now = nowIso(ctx);
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE users SET auth_state = 'disabled' WHERE id = ?").run(user.id);
    ctx.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, user.id);
    ctx.db.prepare("UPDATE clients SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, user.id);
    ctx.db.prepare("UPDATE tasks SET lease_until = ?, version = version + 1, updated_at = ? WHERE holder_user_id = ? AND lease_until > ?").run(now, now, user.id, now);
  })();
  wakeAuthChanged();
  return getUser(ctx, user.id)!;
}
