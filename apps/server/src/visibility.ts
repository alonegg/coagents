import type { ProjectRole } from "@coagents/contract";

export interface Viewer {
  userId: string;
  role: ProjectRole;
}

export function isManager(v: Viewer): boolean {
  return v.role === "owner" || v.role === "admin";
}

// The single rule for who may see an artifact, as a SQL predicate over alias `a`:
// managers see everything that is not deleted; an unpublished artifact is visible to its author;
// a published one to all members, or, when restricted, to its author and the listed members.
// Every list, count, event, notification, download and search goes through this predicate.
export function artifactReadable(alias: string, v: Viewer, opts: { includeDeleted?: boolean } = {}): { sql: string; params: (string | number)[] } {
  const a = alias;
  if (isManager(v)) {
    return { sql: opts.includeDeleted ? "1" : `${a}.status != 'deleted'`, params: [] };
  }
  return {
    sql: `(${a}.status = 'draft' AND ${a}.author_id = ?) OR (${a}.status = 'published' AND (${a}.visibility = 'project' OR ${a}.author_id = ? OR EXISTS (SELECT 1 FROM artifact_grants g WHERE g.artifact_id = ${a}.id AND g.user_id = ?)))`,
    params: [v.userId, v.userId, v.userId],
  };
}
