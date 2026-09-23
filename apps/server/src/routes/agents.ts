import { AgentScope, DeviceCodeRequest, type AgentConnectionView, type DeviceCodeGrant, type DeviceTokenResult } from "@coagents/contract";
import { Hono } from "hono";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { projectAccess, requireActive, requirePermission } from "../access.js";
import { audit } from "../audit.js";
import { requireAuth, type Env } from "../auth.js";
import { nowIso, type AppContext } from "../context.js";
import { HttpError, notFound } from "../http-error.js";
import { hashSecret, newId, newSecret } from "../ids.js";
import { expireLeases } from "../tasks.js";
import { parseBody } from "../validate.js";

const CODE_TTL_SECONDS = 600;
const POLL_INTERVAL_SECONDS = 5;
// No vowels or look-alikes, so codes are easy to read aloud and never spell words.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

function newUserCode(): string {
  const chars = Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function normalizeUserCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

interface CodeRow {
  id: string;
  user_code: string;
  project_id: string;
  client_label: string;
  scopes: string;
  expires_at: string;
  approved_by: string | null;
  client_id: string | null;
  consumed_at: string | null;
  denied_at: string | null;
}

const invalidCode = () => new HttpError(404, "expired_token", "This code is invalid, expired or already used");

export function agentRoutes(ctx: AppContext): Hono<Env> {
  const r = new Hono<Env>();

  // Step 1 (Connector, unauthenticated): request a device code for one project.
  r.post("/device-codes", async (c) => {
    const input = await parseBody(c, DeviceCodeRequest);
    const deviceCode = newSecret();
    const now = ctx.clock();
    const expires = new Date(now.getTime() + CODE_TTL_SECONDS * 1000).toISOString();
    let userCode = newUserCode();
    for (let i = 0; ctx.db.prepare("SELECT 1 FROM device_codes WHERE user_code = ?").get(userCode); i++) {
      if (i > 5) throw new Error("could not allocate a user code");
      userCode = newUserCode();
    }
    ctx.db
      .prepare(
        `INSERT INTO device_codes (id, device_code_hash, user_code, project_id, client_label, scopes, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId("dcd"), hashSecret(deviceCode), userCode, input.project_id, input.client_label, JSON.stringify([...new Set(input.scopes)]), now.toISOString(), expires);
    const grant: DeviceCodeGrant = {
      device_code: deviceCode,
      user_code: userCode,
      verification_url: `${ctx.config.publicUrl}/#/device/${userCode}`,
      expires_in: CODE_TTL_SECONDS,
      interval: POLL_INTERVAL_SECONDS,
    };
    return c.json(grant, 201);
  });

  // Step 3 (Connector, unauthenticated): poll with the secret device code. The agent token is minted
  // once, on the first poll after approval, and only its hash is stored.
  r.post("/device-codes/token", async (c) => {
    const { device_code } = await parseBody(c, z.object({ device_code: z.string().min(16).max(256) }).strict());
    const result = ctx.db.transaction((): DeviceTokenResult => {
      const row = ctx.db
        .prepare("SELECT * FROM device_codes WHERE device_code_hash = ?")
        .get(hashSecret(device_code)) as CodeRow | undefined;
      if (!row || row.consumed_at || row.expires_at <= nowIso(ctx)) throw invalidCode();
      if (row.denied_at) throw new HttpError(403, "not_allowed", "The request was denied in the Hub");
      if (!row.approved_by || !row.client_id) return { status: "pending" };
      const token = newSecret();
      ctx.db.prepare("UPDATE clients SET token_hash = ? WHERE id = ? AND token_hash IS NULL").run(hashSecret(token), row.client_id);
      ctx.db.prepare("UPDATE device_codes SET consumed_at = ? WHERE id = ?").run(nowIso(ctx), row.id);
      const client = ctx.db.prepare("SELECT device_id FROM clients WHERE id = ?").get(row.client_id) as { device_id: string };
      return {
        status: "approved",
        agent_token: token,
        client_id: row.client_id,
        device_id: client.device_id,
        project_id: row.project_id,
        scopes: z.array(AgentScope).parse(JSON.parse(row.scopes)),
      };
    }).immediate();
    return c.json(result);
  });

  function pendingCode(userCode: string, userId: string): CodeRow & { project_name: string } {
    const row = ctx.db
      .prepare(
        `SELECT dc.*, p.name AS project_name FROM device_codes dc
         JOIN projects p ON p.id = dc.project_id
         JOIN memberships m ON m.project_id = dc.project_id AND m.user_id = ?
         WHERE dc.user_code = ? AND dc.approved_by IS NULL AND dc.denied_at IS NULL AND dc.expires_at > ?`,
      )
      .get(userId, normalizeUserCode(userCode), nowIso(ctx)) as (CodeRow & { project_name: string }) | undefined;
    if (!row) throw invalidCode();
    return row;
  }

  // Step 2 (person in the Hub): review what is asking for access, then approve or deny.
  r.get("/device-codes/:userCode", (c) => {
    const auth = requireAuth(c);
    const row = pendingCode(c.req.param("userCode"), auth.user.id);
    return c.json({
      user_code: row.user_code,
      project_id: row.project_id,
      project_name: row.project_name,
      client_label: row.client_label,
      scopes: JSON.parse(row.scopes) as string[],
      expires_at: row.expires_at,
    });
  });

  r.post("/device-codes/:userCode/approve", (c) => {
    const auth = requireAuth(c);
    const result = ctx.db.transaction(() => {
      const row = pendingCode(c.req.param("userCode"), auth.user.id);
      const access = projectAccess(ctx, auth.user.id, row.project_id);
      requirePermission(access, "agent.connect_own");
      requireActive(access);
      const now = nowIso(ctx);
      const deviceId = newId("dev");
      const clientId = newId("cli");
      ctx.db
        .prepare(
          `INSERT INTO devices (id, user_id, kind, label, token_hash, created_at, last_seen_at) VALUES (?, ?, 'connector', ?, ?, ?, ?)`,
        )
        .run(deviceId, auth.user.id, row.client_label, hashSecret(newSecret()), now, now);
      ctx.db
        .prepare(`INSERT INTO clients (id, project_id, user_id, device_id, label, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(clientId, row.project_id, auth.user.id, deviceId, row.client_label, row.scopes, now);
      ctx.db.prepare("UPDATE device_codes SET approved_by = ?, approved_at = ?, client_id = ? WHERE id = ?").run(auth.user.id, now, clientId, row.id);
      audit(ctx, {
        projectId: row.project_id,
        actorUserId: auth.user.id,
        action: "agent.connect",
        objectType: "client",
        objectId: clientId,
        detail: { label: row.client_label, scopes: row.scopes },
      });
      return { client_id: clientId, project_id: row.project_id };
    }).immediate();
    return c.json(result, 201);
  });

  r.post("/device-codes/:userCode/deny", (c) => {
    const auth = requireAuth(c);
    const row = pendingCode(c.req.param("userCode"), auth.user.id);
    ctx.db.prepare("UPDATE device_codes SET denied_at = ? WHERE id = ?").run(nowIso(ctx), row.id);
    return c.body(null, 204);
  });

  // Agent self-service: identify, and revoke its own credential on uninstall.
  r.get("/agent/me", (c) => {
    const agent = c.get("agent");
    if (!agent) throw new HttpError(401, "unauthenticated", "Agent credential required");
    const access = projectAccess(ctx, agent.userId, agent.projectId);
    const project = ctx.db
      .prepare("SELECT id, name, description, lifecycle, timezone FROM projects WHERE id = ?")
      .get(agent.projectId) as { id: string; name: string; description: string; lifecycle: string; timezone: string };
    return c.json({
      client_id: agent.clientId,
      user_id: agent.userId,
      user_display_name: agent.displayName,
      device_id: agent.deviceId,
      scopes: agent.scopes,
      role: access.role,
      project,
    });
  });

  r.delete("/agent/me", (c) => {
    const agent = c.get("agent");
    if (!agent) throw new HttpError(401, "unauthenticated", "Agent credential required");
    revokeClient(ctx, agent.clientId, agent.userId, "agent.self_revoke");
    return c.body(null, 204);
  });

  r.get("/projects/:id/agents", (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    const all = access.role === "owner" || access.role === "admin";
    const rows = ctx.db
      .prepare(
        `SELECT cl.id, cl.label, cl.user_id, u.username, cl.device_id, d.label AS device_label, cl.scopes, cl.created_at, cl.last_seen_at, cl.verified_at
         FROM clients cl JOIN users u ON u.id = cl.user_id JOIN devices d ON d.id = cl.device_id
         WHERE cl.project_id = ? AND cl.revoked_at IS NULL AND d.revoked_at IS NULL AND (? OR cl.user_id = ?)
         ORDER BY cl.created_at DESC`,
      )
      .all(access.projectId, all ? 1 : 0, auth.user.id) as (Omit<AgentConnectionView, "scopes"> & { scopes: string })[];
    return c.json({ agents: rows.map((r) => ({ ...r, scopes: JSON.parse(r.scopes) as string[] })) });
  });

  r.delete("/projects/:id/agents/:clientId", (c) => {
    const auth = requireAuth(c);
    const access = projectAccess(ctx, auth.user.id, c.req.param("id"));
    const row = ctx.db
      .prepare("SELECT user_id FROM clients WHERE id = ? AND project_id = ? AND revoked_at IS NULL")
      .get(c.req.param("clientId"), access.projectId) as { user_id: string } | undefined;
    if (!row) throw notFound();
    requirePermission(access, row.user_id === auth.user.id ? "agent.connect_own" : "agent.revoke_any");
    revokeClient(ctx, c.req.param("clientId"), auth.user.id, "agent.revoke");
    return c.body(null, 204);
  });

  return r;
}

// Revoking a client also releases any lease it holds, so a stale agent cannot keep a task.
export function revokeClient(ctx: AppContext, clientId: string, actorUserId: string, action: string): void {
  const now = nowIso(ctx);
  ctx.db.transaction(() => {
    const row = ctx.db.prepare("SELECT project_id FROM clients WHERE id = ?").get(clientId) as { project_id: string };
    ctx.db.prepare("UPDATE clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, clientId);
    expireLeases(ctx, { clientId });
    audit(ctx, { projectId: row.project_id, actorUserId, action, objectType: "client", objectId: clientId });
  })();
}
