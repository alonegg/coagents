import { roleAllows, type Permission, type ProjectRole } from "@coagents/contract";
import type { AppContext } from "./context.js";
import { HttpError, notAllowed, notFound } from "./http-error.js";

export interface ProjectAccess {
  projectId: string;
  role: ProjectRole;
  lifecycle: "active" | "archived";
}

// Every project-scoped request starts here: non-members get the same 404 whether or not the project exists.
export function projectAccess(ctx: AppContext, userId: string, projectId: string): ProjectAccess {
  const row = ctx.db
    .prepare(
      `SELECT m.role, p.lifecycle FROM memberships m JOIN projects p ON p.id = m.project_id
       WHERE m.project_id = ? AND m.user_id = ?`,
    )
    .get(projectId, userId) as { role: ProjectRole; lifecycle: "active" | "archived" } | undefined;
  if (!row) throw notFound();
  return { projectId, role: row.role, lifecycle: row.lifecycle };
}

export function requirePermission(access: ProjectAccess, permission: Permission): void {
  if (!roleAllows(access.role, permission)) throw notAllowed();
}

export function requireActive(access: ProjectAccess): void {
  if (access.lifecycle === "archived") {
    throw new HttpError(409, "project_archived", "Project is archived; restore it to make changes");
  }
}
