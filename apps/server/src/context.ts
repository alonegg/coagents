import type { Db } from "./db.js";

export type Clock = () => Date;

export interface ServerConfig {
  // Public HTTPS origin, e.g. https://coagents.example.org. Cookies are Secure when it is https.
  publicUrl: string;
  sessionTtlHours: number;
  leaseMinutes: number;
  // Managed storage for uploaded artifact files; never exposed as paths to clients.
  filesDir: string;
  // Release id of the deployed Hub bundle, so open tabs can tell they are stale.
  build?: string;
}

export interface AppContext {
  db: Db;
  clock: Clock;
  config: ServerConfig;
}

export function nowIso(ctx: AppContext): string {
  return ctx.clock().toISOString();
}

// Who performs a write: a person through a browser session, or an agent client acting for them.
export interface Actor {
  kind: "user" | "client";
  userId: string;
  displayName: string;
  deviceId: string;
  clientId: string | null;
}

export function actorKey(a: Actor): string {
  return a.kind === "client" ? `client:${a.clientId}` : `user:${a.userId}`;
}
