import { nowIso, type AppContext } from "./context.js";
import { newId } from "./ids.js";

export interface AuditEntry {
  projectId: string | null;
  actorUserId: string | null;
  action: string;
  objectType: string;
  objectId: string;
  // Metadata only: never credentials or content bodies.
  detail?: Record<string, string | number | boolean | null>;
}

export function audit(ctx: AppContext, e: AuditEntry): void {
  ctx.db
    .prepare(
      `INSERT INTO audit_records (id, project_id, actor_user_id, action, object_type, object_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId("aud"), e.projectId, e.actorUserId, e.action, e.objectType, e.objectId, JSON.stringify(e.detail ?? {}), nowIso(ctx));
}
