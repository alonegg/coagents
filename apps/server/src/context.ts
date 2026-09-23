import type { Db } from "./db.js";

export type Clock = () => Date;

export interface ServerConfig {
  // Public HTTPS origin, e.g. https://coagents.example.org. Cookies are Secure when it is https.
  publicUrl: string;
  sessionTtlHours: number;
}

export interface AppContext {
  db: Db;
  clock: Clock;
  config: ServerConfig;
}

export function nowIso(ctx: AppContext): string {
  return ctx.clock().toISOString();
}
