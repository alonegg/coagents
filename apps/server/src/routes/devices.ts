import type { DeviceView } from "@coagents/contract";
import { Hono } from "hono";
import { audit } from "../audit.js";
import { requireAuth, type Env } from "../auth.js";
import { nowIso, type AppContext } from "../context.js";
import { notFound } from "../http-error.js";
import { expireLeases } from "../tasks.js";

export function deviceRoutes(ctx: AppContext): Hono<Env> {
  const r = new Hono<Env>();

  r.get("/", (c) => {
    const auth = requireAuth(c);
    const rows = ctx.db
      .prepare(
        `SELECT id, kind, label, created_at, last_seen_at FROM devices
         WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC`,
      )
      .all(auth.user.id) as Omit<DeviceView, "current">[];
    return c.json({ devices: rows.map((d) => ({ ...d, current: d.id === auth.deviceId })) });
  });

  // Revoking a device ends every session bound to it; other devices of the same user are untouched.
  r.delete("/:id", (c) => {
    const auth = requireAuth(c);
    const id = c.req.param("id");
    const now = nowIso(ctx);
    const changed = ctx.db.transaction(() => {
      const res = ctx.db
        .prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
        .run(now, id, auth.user.id);
      if (res.changes === 1) {
        ctx.db.prepare("UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").run(now, id);
        ctx.db.prepare("UPDATE clients SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").run(now, id);
        expireLeases(ctx, { deviceId: id });
        audit(ctx, { projectId: null, actorUserId: auth.user.id, action: "device.revoke", objectType: "device", objectId: id });
      }
      return res.changes;
    })();
    if (changed === 0) throw notFound();
    return c.body(null, 204);
  });

  return r;
}
