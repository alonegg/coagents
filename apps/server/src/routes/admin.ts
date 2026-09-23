import { InstanceSettingsInput } from "@coagents/contract";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { SERVER_VERSION } from "../app.js";
import { audit } from "../audit.js";
import { requireAuth, type AuthState, type Env } from "../auth.js";
import { wakeAuthChanged } from "../bus.js";
import type { AppContext } from "../context.js";
import { schemaVersion } from "../db.js";
import { appendEvent } from "../events.js";
import { invalid, notAllowed, notFound } from "../http-error.js";
import { settings, setSetting } from "../instance.js";
import { decide, listRegistrations } from "../registrations.js";
import { openStreamCount } from "../stream.js";
import { disableUser, enableUser, getUser, issueTemporaryPassword } from "../users.js";
import { parseBody } from "../validate.js";

const startedAt = new Date().toISOString();

// Instance administration. Maintainers manage accounts and the instance; they do not gain access to
// project content here: projects appear as metadata only.
function requireMaintainer(c: Context<Env>): AuthState {
  const auth = requireAuth(c);
  if (auth.user.instance_role !== "maintainer") throw notFound();
  return auth;
}

function activeMaintainers(ctx: AppContext): number {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE instance_role = 'maintainer' AND auth_state = 'active'").get() as { n: number }).n;
}

function userRow(ctx: AppContext, id: string): { id: string; username: string; instance_role: string; auth_state: string } {
  const u = ctx.db.prepare("SELECT id, username, instance_role, auth_state FROM users WHERE id = ?").get(id) as ReturnType<typeof userRow> | undefined;
  if (!u) throw notFound();
  return u;
}

export function adminRoutes(ctx: AppContext): Hono<Env> {
  const r = new Hono<Env>();

  r.get("/overview", (c) => {
    requireMaintainer(c);
    const one = (sql: string) => (ctx.db.prepare(sql).get() as { n: number }).n;
    const group = (sql: string) => Object.fromEntries((ctx.db.prepare(sql).all() as { k: string; n: number }[]).map((r) => [r.k, r.n]));
    let lastBackup: string | null = null;
    const dir = ctx.config.backupDir;
    if (dir) {
      try {
        const files = readdirSync(dir).filter((f) => f.endsWith(".tgz")).map((f) => statSync(join(dir, f)).mtime.toISOString());
        lastBackup = files.sort().pop() ?? null;
      } catch {
        lastBackup = null;
      }
    }
    return c.json({
      version: SERVER_VERSION,
      build: ctx.config.build ?? null,
      schema_version: schemaVersion(ctx.db),
      started_at: startedAt,
      open_streams: openStreamCount(),
      users: group("SELECT auth_state AS k, COUNT(*) AS n FROM users GROUP BY 1"),
      pending_registrations: one("SELECT COUNT(*) AS n FROM registrations WHERE status = 'pending'"),
      projects: group("SELECT CASE WHEN deleted_at IS NOT NULL THEN 'deleted' ELSE lifecycle END AS k, COUNT(*) AS n FROM projects GROUP BY 1"),
      tasks: one("SELECT COUNT(*) AS n FROM tasks"),
      events: one("SELECT COUNT(*) AS n FROM events"),
      artifacts: one("SELECT COUNT(*) AS n FROM artifacts WHERE status != 'deleted'"),
      file_bytes: one("SELECT COALESCE(SUM(size), 0) AS n FROM stored_files"),
      active_agents: one("SELECT COUNT(*) AS n FROM clients WHERE revoked_at IS NULL AND token_hash IS NOT NULL"),
      search_index: group("SELECT index_state AS k, COUNT(*) AS n FROM search_docs GROUP BY 1"),
      last_backup_at: lastBackup,
    });
  });

  r.get("/registrations", (c) => {
    requireMaintainer(c);
    const status = c.req.query("status");
    if (status && !["pending", "approved", "rejected"].includes(status)) throw invalid("Unknown status");
    return c.json({ registrations: listRegistrations(ctx, status) });
  });

  r.post("/registrations/:id/:decision{approve|reject}", async (c) => {
    const auth = requireMaintainer(c);
    const { note } = await parseBody(c, z.object({ note: z.string().max(1000).optional() }).strict());
    const approve = c.req.param("decision") === "approve";
    if (!approve && !note?.trim()) throw invalid("Give a reason for rejecting");
    const user = decide(ctx, c.req.param("id"), auth.user.id, approve, note?.trim());
    return c.json({ user });
  });

  r.get("/users", (c) => {
    requireMaintainer(c);
    const q = (c.req.query("q") ?? "").trim();
    const state = c.req.query("state");
    const users = ctx.db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.email, u.instance_role, u.auth_state, u.must_change_password = 1 AS must_change_password,
                u.created_at, u.last_login_at,
                (SELECT COUNT(*) FROM memberships m JOIN projects p ON p.id = m.project_id WHERE m.user_id = u.id AND p.deleted_at IS NULL) AS projects,
                (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices
         FROM users u
         WHERE (? = '' OR u.username LIKE ? OR u.display_name LIKE ? OR COALESCE(u.email, '') LIKE ?) ${state ? "AND u.auth_state = ?" : ""}
         ORDER BY u.created_at DESC LIMIT 500`,
      )
      .all(q, `%${q}%`, `%${q}%`, `%${q}%`, ...(state ? [state] : []));
    return c.json({ users });
  });

  r.post("/users/:id/disable", (c) => {
    const auth = requireMaintainer(c);
    const u = userRow(ctx, c.req.param("id"));
    if (u.id === auth.user.id) throw notAllowed("You cannot disable yourself");
    if (u.instance_role === "maintainer" && u.auth_state === "active" && activeMaintainers(ctx) <= 1) throw notAllowed("At least one active maintainer must remain");
    disableUser(ctx, u.username);
    audit(ctx, { projectId: null, actorUserId: auth.user.id, action: "user.disable", objectType: "user", objectId: u.id, detail: { username: u.username } });
    return c.json(getUser(ctx, u.id));
  });

  r.post("/users/:id/enable", (c) => {
    const auth = requireMaintainer(c);
    const u = userRow(ctx, c.req.param("id"));
    enableUser(ctx, u.id);
    audit(ctx, { projectId: null, actorUserId: auth.user.id, action: "user.enable", objectType: "user", objectId: u.id, detail: { username: u.username } });
    return c.json(getUser(ctx, u.id));
  });

  // The temporary password is shown once, to hand over out of band; the user must replace it.
  r.post("/users/:id/reset-password", async (c) => {
    const auth = requireMaintainer(c);
    const u = userRow(ctx, c.req.param("id"));
    if (u.id === auth.user.id) throw notAllowed("Change your own password from your account page");
    const temporary_password = await issueTemporaryPassword(ctx, u.id);
    audit(ctx, { projectId: null, actorUserId: auth.user.id, action: "user.password_reset", objectType: "user", objectId: u.id, detail: { username: u.username } });
    return c.json({ temporary_password });
  });

  r.post("/users/:id/role", async (c) => {
    const auth = requireMaintainer(c);
    const { instance_role } = await parseBody(c, z.object({ instance_role: z.enum(["maintainer", "member"]) }).strict());
    const u = userRow(ctx, c.req.param("id"));
    if (u.id === auth.user.id) throw notAllowed("You cannot change your own instance role");
    if (u.auth_state !== "active") throw notAllowed("Enable the account first");
    ctx.db.prepare("UPDATE users SET instance_role = ? WHERE id = ?").run(instance_role, u.id);
    audit(ctx, { projectId: null, actorUserId: auth.user.id, action: "user.role", objectType: "user", objectId: u.id, detail: { username: u.username, instance_role } });
    wakeAuthChanged();
    return c.json(getUser(ctx, u.id));
  });

  // Metadata only: no descriptions, tasks, artifacts or events.
  r.get("/projects", (c) => {
    requireMaintainer(c);
    const projects = ctx.db
      .prepare(
        `SELECT p.id, p.name, p.lifecycle, p.created_at, p.deleted_at IS NOT NULL AS deleted,
                o.id AS owner_id, o.username AS owner_username, o.auth_state AS owner_state,
                (SELECT COUNT(*) FROM memberships m WHERE m.project_id = p.id) AS members,
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS tasks,
                (SELECT MAX(created_at) FROM events e WHERE e.project_id = p.id) AS last_activity_at
         FROM projects p
         LEFT JOIN memberships om ON om.project_id = p.id AND om.role = 'owner'
         LEFT JOIN users o ON o.id = om.user_id
         ORDER BY p.deleted_at IS NOT NULL, last_activity_at DESC`,
      )
      .all();
    return c.json({ projects });
  });

  r.get("/projects/:id/members", (c) => {
    requireMaintainer(c);
    const members = ctx.db
      .prepare(`SELECT u.id, u.username, u.display_name, u.auth_state, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.role, u.username`)
      .all(c.req.param("id"));
    return c.json({ members });
  });

  // Only for a project whose owner account is disabled: hand ownership to an existing active member.
  r.post("/projects/:id/owner", async (c) => {
    const auth = requireMaintainer(c);
    const { user_id } = await parseBody(c, z.object({ user_id: z.string().min(1).max(64) }).strict());
    const pid = c.req.param("id");
    ctx.db.transaction(() => {
      const owner = ctx.db
        .prepare("SELECT u.id, u.auth_state FROM memberships m JOIN users u ON u.id = m.user_id JOIN projects p ON p.id = m.project_id WHERE m.project_id = ? AND m.role = 'owner' AND p.deleted_at IS NULL")
        .get(pid) as { id: string; auth_state: string } | undefined;
      if (!owner) throw notFound();
      if (owner.auth_state === "active") throw notAllowed("The owner is active; ownership moves only by the owner's own transfer");
      const target = ctx.db
        .prepare("SELECT u.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND m.user_id = ? AND u.auth_state = 'active'")
        .get(pid, user_id) as { id: string; display_name: string } | undefined;
      if (!target) throw invalid("The new owner must be an active member of the project");
      ctx.db.prepare("UPDATE memberships SET role = 'admin' WHERE project_id = ? AND user_id = ?").run(pid, owner.id);
      ctx.db.prepare("UPDATE memberships SET role = 'owner' WHERE project_id = ? AND user_id = ?").run(pid, target.id);
      audit(ctx, { projectId: pid, actorUserId: auth.user.id, action: "ownership.recover", objectType: "user", objectId: target.id, detail: { previous_owner: owner.id } });
      appendEvent(ctx, pid, { kind: "user", userId: auth.user.id, displayName: auth.user.display_name, deviceId: auth.deviceId, clientId: null }, {
        kind: "member.ownership_transferred",
        subjectType: "user",
        subjectId: target.id,
        summary: `实例维护者将所有权转给 ${target.display_name}（原 Owner 已停用）`,
        data: { previous_owner: owner.id, by_maintainer: true },
      });
    })();
    wakeAuthChanged();
    return c.json({ ok: true });
  });

  r.get("/settings", (c) => {
    requireMaintainer(c);
    return c.json(settings(ctx));
  });

  r.put("/settings", async (c) => {
    const auth = requireMaintainer(c);
    const input = await parseBody(c, InstanceSettingsInput);
    for (const [k, v] of Object.entries(input)) if (v !== undefined) setSetting(ctx, k as "registration_mode", v);
    audit(ctx, { projectId: null, actorUserId: auth.user.id, action: "instance.settings", objectType: "instance", objectId: "settings", detail: Object.fromEntries(Object.entries(input).map(([k, v]) => [k, k === "announcement" ? `${String(v).length} chars` : String(v)])) });
    return c.json(settings(ctx));
  });

  // Instance-level audit: accounts, registrations, sign-in failures and settings (not project records).
  r.get("/audit", (c) => {
    requireMaintainer(c);
    const records = ctx.db
      .prepare(
        `SELECT a.id, a.action, a.object_type, a.object_id, a.detail, a.created_at, u.username AS actor
         FROM audit_records a LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.project_id IS NULL OR a.action = 'ownership.recover'
         ORDER BY a.created_at DESC LIMIT 300`,
      )
      .all() as { detail: string }[];
    return c.json({ records: records.map((r) => ({ ...r, detail: JSON.parse(r.detail) as unknown })) });
  });

  return r;
}
