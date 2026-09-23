import { RegisterInput, type AssignableRole, type InvitationPreview } from "@coagents/contract";
import { Hono } from "hono";
import { audit } from "../audit.js";
import { requireAuth, startSession, type Env } from "../auth.js";
import { nowIso, type AppContext } from "../context.js";
import { HttpError } from "../http-error.js";
import { hashSecret } from "../ids.js";
import { createUser } from "../users.js";
import { parseBody } from "../validate.js";

interface PendingInvitation {
  id: string;
  project_id: string;
  project_name: string;
  lifecycle: "active" | "archived";
  role: AssignableRole;
  target_username: string | null;
  expires_at: string;
}

const invalidInvitation = () =>
  new HttpError(404, "invitation_invalid", "This invitation is invalid, expired, revoked or already used");

// Only a pending, unexpired invitation of an active project is usable; every other case looks the same.
function pendingInvitation(ctx: AppContext, token: string): PendingInvitation {
  const row = ctx.db
    .prepare(
      `SELECT i.id, i.project_id, p.name AS project_name, p.lifecycle, i.role, i.target_username, i.expires_at
       FROM invitations i JOIN projects p ON p.id = i.project_id
       WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?`,
    )
    .get(hashSecret(token), nowIso(ctx)) as PendingInvitation | undefined;
  if (!row || row.lifecycle !== "active") throw invalidInvitation();
  return row;
}

export function invitationRoutes(ctx: AppContext): Hono<Env> {
  const r = new Hono<Env>();

  r.get("/:token", (c) => {
    const inv = pendingInvitation(ctx, c.req.param("token"));
    const preview: InvitationPreview = {
      project_name: inv.project_name,
      role: inv.role,
      target_username: inv.target_username,
      expires_at: inv.expires_at,
      transferable: inv.target_username === null,
    };
    return c.json(preview);
  });

  // Registration needs a valid invitation but does not grant membership; the new user accepts explicitly.
  r.post("/:token/register", async (c) => {
    const inv = pendingInvitation(ctx, c.req.param("token"));
    const input = await parseBody(c, RegisterInput);
    if (inv.target_username !== null && inv.target_username !== input.username) {
      throw new HttpError(403, "not_allowed", "This invitation is for a different username");
    }
    const user = await createUser(ctx, {
      username: input.username,
      displayName: input.display_name,
      timezone: input.timezone,
      password: input.password,
      instanceRole: "member",
    });
    audit(ctx, { projectId: null, actorUserId: user.id, action: "user.register", objectType: "user", objectId: user.id, detail: { invitation: inv.id } });
    return c.json(startSession(ctx, c, user), 201);
  });

  r.post("/:token/accept", (c) => {
    const auth = requireAuth(c);
    const token = c.req.param("token");
    const projectId = ctx.db.transaction(() => {
      const inv = pendingInvitation(ctx, token);
      if (inv.target_username !== null && inv.target_username !== auth.user.username) {
        throw new HttpError(403, "not_allowed", "This invitation is for a different username");
      }
      const existing = ctx.db
        .prepare("SELECT 1 FROM memberships WHERE project_id = ? AND user_id = ?")
        .get(inv.project_id, auth.user.id);
      if (existing) throw new HttpError(409, "already_member", "You are already a member of this project");
      const now = nowIso(ctx);
      ctx.db
        .prepare("UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL")
        .run(now, auth.user.id, inv.id);
      ctx.db
        .prepare("INSERT INTO memberships (project_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)")
        .run(inv.project_id, auth.user.id, inv.role, now);
      audit(ctx, {
        projectId: inv.project_id,
        actorUserId: auth.user.id,
        action: "invitation.accept",
        objectType: "invitation",
        objectId: inv.id,
        detail: { role: inv.role },
      });
      return inv.project_id;
    }).immediate();
    return c.json({ project_id: projectId }, 201);
  });

  return r;
}
