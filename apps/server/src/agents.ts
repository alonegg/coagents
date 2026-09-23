import { agentAllows, type AgentScope, type Permission, type ProjectRole } from "@coagents/contract";
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./auth.js";
import { nowIso, type AppContext } from "./context.js";
import { HttpError, notAllowed } from "./http-error.js";
import { hashSecret } from "./ids.js";

export interface AgentState {
  clientId: string;
  projectId: string;
  userId: string;
  displayName: string;
  deviceId: string;
  scopes: AgentScope[];
}

const SEEN_RESOLUTION_MS = 60_000;

// Resolves "Authorization: Bearer <agent token>". A token is valid only while its client, device and
// user are active; membership and role are checked per request by the project routes.
export function agentMiddleware(ctx: AppContext): MiddlewareHandler<Env> {
  return async (c, next) => {
    c.set("agent", null);
    const header = c.req.header("authorization");
    if (header?.startsWith("Bearer ")) {
      const row = ctx.db
        .prepare(
          `SELECT cl.id, cl.project_id, cl.user_id, cl.device_id, cl.scopes, cl.last_seen_at, cl.verified_at, u.display_name
           FROM clients cl JOIN devices d ON d.id = cl.device_id JOIN users u ON u.id = cl.user_id
           WHERE cl.token_hash = ? AND cl.revoked_at IS NULL AND d.revoked_at IS NULL AND u.auth_state = 'active'`,
        )
        .get(hashSecret(header.slice(7).trim())) as
        | { id: string; project_id: string; user_id: string; device_id: string; scopes: string; last_seen_at: string | null; verified_at: string | null; display_name: string }
        | undefined;
      if (!row) throw new HttpError(401, "unauthenticated", "Agent credential is invalid or revoked");
      const now = nowIso(ctx);
      if (!row.last_seen_at || Date.parse(now) - Date.parse(row.last_seen_at) > SEEN_RESOLUTION_MS || !row.verified_at) {
        ctx.db.prepare("UPDATE clients SET last_seen_at = ?, verified_at = COALESCE(verified_at, ?) WHERE id = ?").run(now, now, row.id);
        ctx.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, row.device_id);
      }
      c.set("agent", {
        clientId: row.id,
        projectId: row.project_id,
        userId: row.user_id,
        displayName: row.display_name,
        deviceId: row.device_id,
        scopes: JSON.parse(row.scopes) as AgentScope[],
      });
    }
    await next();
  };
}

export function requireAgentPermission(agent: AgentState, role: ProjectRole, permission: Permission): void {
  if (!agentAllows(role, agent.scopes, permission)) throw notAllowed("This agent connection is not allowed to do that");
}

export function isAgent(c: Context<Env>): boolean {
  return c.get("agent") != null;
}

export function clientStillValid(ctx: AppContext, clientId: string): boolean {
  return (
    ctx.db
      .prepare(
        `SELECT 1 FROM clients cl JOIN devices d ON d.id = cl.device_id JOIN users u ON u.id = cl.user_id
         WHERE cl.id = ? AND cl.revoked_at IS NULL AND d.revoked_at IS NULL AND u.auth_state = 'active'`,
      )
      .get(clientId) !== undefined
  );
}
