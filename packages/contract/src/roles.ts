import { z } from "zod";

export const ProjectRole = z.enum(["owner", "admin", "contributor", "viewer"]);
export type ProjectRole = z.infer<typeof ProjectRole>;

// Roles an invitation or role change may grant; ownership only moves by explicit transfer.
export const AssignableRole = z.enum(["admin", "contributor", "viewer"]);
export type AssignableRole = z.infer<typeof AssignableRole>;

// Project permissions from PRD section 9. Object-level rules (own drafts, restricted lists,
// "admin cannot act on owner or self") are enforced separately in the server.
export const Permission = z.enum([
  "project.read",
  "task.write",
  "task.review",
  "artifact.write_own",
  "artifact.manage_all",
  "member.manage",
  "agent.connect_own",
  "agent.revoke_any",
  "project.archive",
  "project.transfer_or_delete",
  "milestone.manage",
]);
export type Permission = z.infer<typeof Permission>;

export const ROLE_PERMISSIONS: Record<ProjectRole, readonly Permission[]> = {
  owner: Permission.options,
  admin: Permission.options.filter((p) => p !== "project.transfer_or_delete"),
  contributor: ["project.read", "task.write", "artifact.write_own", "agent.connect_own"],
  viewer: ["project.read"],
};

export function roleAllows(role: ProjectRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

const SCOPE_PERMISSIONS: Record<"read" | "write", readonly Permission[]> = {
  read: ["project.read"],
  write: ["task.write", "artifact.write_own"],
};

// Agents never manage members, review, archive or transfer, whatever their user's role.
export function agentAllows(role: ProjectRole, scopes: readonly ("read" | "write")[], permission: Permission): boolean {
  return roleAllows(role, permission) && scopes.some((s) => SCOPE_PERMISSIONS[s].includes(permission));
}
