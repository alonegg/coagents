import {
  ChangeRoleInput,
  CreateInvitationInput,
  CreateProjectInput,
  TransferOwnershipInput,
  type InvitationView,
  type MemberView,
  type ProjectRole,
  type ProjectView,
} from "@coagents/contract";
import { Hono } from "hono";
import { projectAccess, requireActive, requirePermission, type ProjectAccess } from "../access.js";
import { audit } from "../audit.js";
import { requireAuth, type Env } from "../auth.js";
import { nowIso, type AppContext } from "../context.js";
import { HttpError, invalid, notAllowed, notFound } from "../http-error.js";
import { hashSecret, newId, newSecret } from "../ids.js";
import { expireLeases } from "../tasks.js";
import { wakeAuthChanged } from "../bus.js";
import { appendEvent } from "../events.js";
import type { AuthState } from "../auth.js";
import type { Actor } from "../context.js";

function humanActor(auth: AuthState): Actor {
  return { kind: "user", userId: auth.user.id, displayName: auth.user.display_name, deviceId: auth.deviceId, clientId: null };
}
import { parseBody } from "../validate.js";

const PROJECT_COLUMNS = "p.id, p.name, p.description, p.lifecycle, p.timezone, p.due_at, m.role, p.created_at, p.updated_at";

function memberRole(ctx: AppContext, projectId: string, userId: string): ProjectRole | undefined {
  const row = ctx.db
    .prepare("SELECT role FROM memberships WHERE project_id = ? AND user_id = ?")
    .get(projectId, userId) as { role: ProjectRole } | undefined;
  return row?.role;
}

export function invitationState(row: {
  accepted_at: string | null;
  revoked_at: string | null;
  expires_at: string;
}, now: string): InvitationView["state"] {
  if (row.accepted_at) return "accepted";
  if (row.revoked_at) return "revoked";
  if (row.expires_at <= now) return "expired";
  return "pending";
}

export function projectRoutes(ctx: AppContext): Hono<Env> {
  const r = new Hono<Env>();

  r.get("/", (c) => {
    const auth = requireAuth(c);
    const lifecycle = c.req.query("lifecycle") === "archived" ? "archived" : "active";
    const rows = ctx.db
      .prepare(
        `SELECT ${PROJECT_COLUMNS} FROM projects p JOIN memberships m ON m.project_id = p.id
         WHERE m.user_id = ? AND p.lifecycle = ? ORDER BY p.updated_at DESC`,
      )
      .all(auth.user.id, lifecycle) as ProjectView[];
    return c.json({ projects: rows });
  });

  r.post("/", async (c) => {
    const auth = requireAuth(c);
    const input = await parseBody(c, CreateProjectInput);
    const id = newId("prj");
    const now = nowIso(ctx);
    ctx.db.transaction(() => {
      ctx.db
        .prepare(
          `INSERT INTO projects (id, name, description, lifecycle, timezone, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(id, input.name, input.description, input.timezone ?? auth.user.timezone, now, now);
      ctx.db
        .prepare("INSERT INTO memberships (project_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
        .run(id, auth.user.id, now);
      audit(ctx, { projectId: id, actorUserId: auth.user.id, action: "project.create", objectType: "project", objectId: id });
    })();
    return c.json(getProject(ctx, auth.user.id, id), 201);
  });

  r.get("/:id", (c) => {
    const auth = requireAuth(c);
    projectAccess(ctx, auth.user.id, c.req.param("id"));
    return c.json(getProject(ctx, auth.user.id, c.req.param("id")));
  });

  r.get("/:id/members", (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    const members = ctx.db
      .prepare(
        `SELECT m.user_id, u.username, u.display_name, m.role, m.joined_at
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?
         ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'contributor' THEN 2 ELSE 3 END, u.username`,
      )
      .all(access.projectId) as MemberView[];
    return c.json({ members });
  });

  // Admins cannot act on the owner or on themselves; the owner role only moves by transfer.
  function guardMemberChange(access: ProjectAccess, actorId: string, targetId: string): ProjectRole {
    requirePermission(access, "member.manage");
    requireActive(access);
    const targetRole = memberRole(ctx, access.projectId, targetId);
    if (!targetRole) throw notFound();
    if (targetRole === "owner") throw notAllowed("The owner's membership can only change by ownership transfer");
    if (targetId === actorId) throw notAllowed("You cannot change your own membership");
    return targetRole;
  }

  r.patch("/:id/members/:userId", async (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    const targetId = c.req.param("userId");
    const from = guardMemberChange(access, auth.user.id, targetId);
    const input = await parseBody(c, ChangeRoleInput);
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE memberships SET role = ? WHERE project_id = ? AND user_id = ?").run(input.role, access.projectId, targetId);
      appendEvent(ctx, access.projectId, humanActor(auth), {
        kind: "member.role_changed",
        subjectType: "user",
        subjectId: targetId,
        summary: `调整成员角色为 ${input.role}`,
        data: { target_user_id: targetId, from, to: input.role },
      });
      audit(ctx, {
        projectId: access.projectId,
        actorUserId: auth.user.id,
        action: "member.role_change",
        objectType: "user",
        objectId: targetId,
        detail: { from, to: input.role },
      });
    })();
    wakeAuthChanged();
    return c.json({ user_id: targetId, role: input.role });
  });

  r.delete("/:id/members/:userId", (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    const targetId = c.req.param("userId");
    const from = guardMemberChange(access, auth.user.id, targetId);
    const now = nowIso(ctx);
    ctx.db.transaction(() => {
      ctx.db.prepare("DELETE FROM memberships WHERE project_id = ? AND user_id = ?").run(access.projectId, targetId);
      ctx.db.prepare("UPDATE clients SET revoked_at = ? WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL").run(now, access.projectId, targetId);
      expireLeases(ctx, { projectId: access.projectId, userId: targetId });
      appendEvent(ctx, access.projectId, humanActor(auth), {
        kind: "member.removed",
        subjectType: "user",
        subjectId: targetId,
        summary: "移除了一位成员",
        data: { target_user_id: targetId },
      });
      ctx.db
        .prepare(
          `UPDATE ownership_transfers SET resolved_at = ?, outcome = 'cancelled'
           WHERE project_id = ? AND to_user_id = ? AND resolved_at IS NULL`,
        )
        .run(now, access.projectId, targetId);
      audit(ctx, {
        projectId: access.projectId,
        actorUserId: auth.user.id,
        action: "member.remove",
        objectType: "user",
        objectId: targetId,
        detail: { role: from },
      });
    })();
    wakeAuthChanged();
    return c.body(null, 204);
  });

  r.get("/:id/invitations", (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    requirePermission(access, "member.manage");
    const now = nowIso(ctx);
    const rows = ctx.db
      .prepare(
        `SELECT id, role, target_username, created_at, expires_at, accepted_at, revoked_at
         FROM invitations WHERE project_id = ? ORDER BY created_at DESC`,
      )
      .all(access.projectId) as (Omit<InvitationView, "state"> & { accepted_at: string | null; revoked_at: string | null })[];
    const invitations: InvitationView[] = rows.map(({ accepted_at, revoked_at, ...rest }) => ({
      ...rest,
      state: invitationState({ accepted_at, revoked_at, expires_at: rest.expires_at }, now),
    }));
    return c.json({ invitations });
  });

  // The token is returned once; only its hash is stored.
  r.post("/:id/invitations", async (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    requirePermission(access, "member.manage");
    requireActive(access);
    const input = await parseBody(c, CreateInvitationInput);
    const token = newSecret();
    const id = newId("inv");
    const now = ctx.clock();
    const expires = new Date(now.getTime() + input.expires_in_hours * 3600_000).toISOString();
    ctx.db.transaction(() => {
      ctx.db
        .prepare(
          `INSERT INTO invitations (id, project_id, role, target_username, token_hash, created_by, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, access.projectId, input.role, input.target_username ?? null, hashSecret(token), auth.user.id, now.toISOString(), expires);
      audit(ctx, {
        projectId: access.projectId,
        actorUserId: auth.user.id,
        action: "invitation.create",
        objectType: "invitation",
        objectId: id,
        detail: { role: input.role, targeted: input.target_username !== undefined },
      });
    })();
    return c.json(
      {
        id,
        role: input.role,
        target_username: input.target_username ?? null,
        expires_at: expires,
        token,
        url: `${ctx.config.publicUrl}/#/invite/${token}`,
      },
      201,
    );
  });

  r.delete("/:id/invitations/:invId", (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    requirePermission(access, "member.manage");
    const invId = c.req.param("invId");
    const changed = ctx.db.transaction(() => {
      const res = ctx.db
        .prepare(
          `UPDATE invitations SET revoked_at = ? WHERE id = ? AND project_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
        )
        .run(nowIso(ctx), invId, access.projectId);
      if (res.changes === 1) {
        audit(ctx, { projectId: access.projectId, actorUserId: auth.user.id, action: "invitation.revoke", objectType: "invitation", objectId: invId });
      }
      return res.changes;
    })();
    if (changed === 0) throw notFound();
    return c.body(null, 204);
  });

  r.get("/:id/ownership-transfer", (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    const row = ctx.db
      .prepare(
        `SELECT id, from_user_id, to_user_id, created_at FROM ownership_transfers
         WHERE project_id = ? AND resolved_at IS NULL`,
      )
      .get(access.projectId) as { id: string; from_user_id: string; to_user_id: string; created_at: string } | undefined;
    const visible = row && (row.from_user_id === auth.user.id || row.to_user_id === auth.user.id);
    return c.json({ transfer: visible ? row : null });
  });

  r.post("/:id/ownership-transfer", async (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    requirePermission(access, "project.transfer_or_delete");
    requireActive(access);
    const input = await parseBody(c, TransferOwnershipInput);
    if (input.user_id === auth.user.id) throw invalid("You already own this project");
    if (!memberRole(ctx, access.projectId, input.user_id)) throw notFound();
    const id = newId("otr");
    try {
      ctx.db.transaction(() => {
        ctx.db
          .prepare(
            "INSERT INTO ownership_transfers (id, project_id, from_user_id, to_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, access.projectId, auth.user.id, input.user_id, nowIso(ctx));
        audit(ctx, { projectId: access.projectId, actorUserId: auth.user.id, action: "ownership.offer", objectType: "user", objectId: input.user_id });
      })();
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new HttpError(409, "version_conflict", "An ownership transfer is already pending");
      }
      throw err;
    }
    return c.json({ id, to_user_id: input.user_id }, 201);
  });

  // The target accepts; the previous owner becomes admin in the same transaction, keeping exactly one owner.
  r.post("/:id/ownership-transfer/accept", (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    requireActive(access);
    const now = nowIso(ctx);
    ctx.db.transaction(() => {
      const t = ctx.db
        .prepare(
          `SELECT id, from_user_id FROM ownership_transfers WHERE project_id = ? AND to_user_id = ? AND resolved_at IS NULL`,
        )
        .get(access.projectId, auth.user.id) as { id: string; from_user_id: string } | undefined;
      if (!t) throw notFound();
      if (memberRole(ctx, access.projectId, t.from_user_id) !== "owner") throw notFound();
      ctx.db.prepare("UPDATE memberships SET role = 'admin' WHERE project_id = ? AND user_id = ?").run(access.projectId, t.from_user_id);
      ctx.db.prepare("UPDATE memberships SET role = 'owner' WHERE project_id = ? AND user_id = ?").run(access.projectId, auth.user.id);
      ctx.db.prepare("UPDATE ownership_transfers SET resolved_at = ?, outcome = 'accepted' WHERE id = ?").run(now, t.id);
      audit(ctx, { projectId: access.projectId, actorUserId: auth.user.id, action: "ownership.accept", objectType: "user", objectId: auth.user.id, detail: { previous_owner: t.from_user_id } });
      appendEvent(ctx, access.projectId, humanActor(auth), {
        kind: "member.ownership_transferred",
        subjectType: "user",
        subjectId: auth.user.id,
        summary: "接受了项目所有权",
        data: { previous_owner: t.from_user_id },
      });
    })();
    wakeAuthChanged();
    return c.json(getProject(ctx, auth.user.id, access.projectId));
  });

  r.delete("/:id/ownership-transfer", (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    requirePermission(access, "project.transfer_or_delete");
    const res = ctx.db
      .prepare(
        `UPDATE ownership_transfers SET resolved_at = ?, outcome = 'cancelled' WHERE project_id = ? AND resolved_at IS NULL`,
      )
      .run(nowIso(ctx), access.projectId);
    if (res.changes === 0) throw notFound();
    return c.body(null, 204);
  });

  r.get("/:id/audit", (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    requirePermission(access, "member.manage");
    const records = ctx.db
      .prepare(
        `SELECT a.id, a.action, a.object_type, a.object_id, a.detail, a.created_at, u.username AS actor
         FROM audit_records a LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.project_id = ? ORDER BY a.created_at DESC, a.id LIMIT 200`,
      )
      .all(access.projectId) as { detail: string }[];
    return c.json({ records: records.map((r) => ({ ...r, detail: JSON.parse(r.detail) as unknown })) });
  });

  return r;
}

function getProject(ctx: AppContext, userId: string, projectId: string): ProjectView {
  return ctx.db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects p JOIN memberships m ON m.project_id = p.id WHERE p.id = ? AND m.user_id = ?`)
    .get(projectId, userId) as ProjectView;
}
