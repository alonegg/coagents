import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "../apps/server/src/app.js";
import type { AppContext } from "../apps/server/src/context.js";
import { openDb } from "../apps/server/src/db.js";
import { createUser } from "../apps/server/src/users.js";

export const PASSWORD = "correct horse battery";

export async function liveServer(): Promise<{ base: string; ctx: AppContext; close: () => void }> {
  const ctx: AppContext = { db: openDb(":memory:"), clock: () => new Date(), config: { publicUrl: "http://127.0.0.1", sessionTtlHours: 1, leaseMinutes: 30, filesDir: mkdtempSync(join(tmpdir(), "coagents-files-")) } };
  return new Promise((resolve) => {
    const s = serve({ fetch: createApp(ctx).fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      ctx.config.publicUrl = `http://127.0.0.1:${info.port}`;
      resolve({ base: ctx.config.publicUrl, ctx, close: () => s.close() });
    });
  });
}

export interface Session {
  cookie: string;
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
}

export async function signIn(base: string, ctx: AppContext, username: string, create = true): Promise<Session> {
  if (create) await createUser(ctx, { username, displayName: username, timezone: "UTC", password: PASSWORD, instanceRole: "member" });
  const res = await fetch(`${base}/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": `test-${username}-${Math.random()}` },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const { csrf_token } = (await res.json()) as { csrf_token: string };
  return {
    cookie,
    call: async (method, path, body) => {
      const r = await fetch(`${base}/v1${path}`, {
        method,
        headers: { cookie, "x-csrf-token": csrf_token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    },
  };
}

export function until<T>(check: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = check();
      if (v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}
