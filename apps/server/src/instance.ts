import type { RegistrationMode } from "@coagents/contract";
import type { AppContext } from "./context.js";

const DEFAULTS = { registration_mode: "approval", site_name: "CoAgents", announcement: "" } as const;
type Key = keyof typeof DEFAULTS;

export function getSetting(ctx: AppContext, key: Key): string {
  const row = ctx.db.prepare("SELECT value FROM instance_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULTS[key];
}

export function setSetting(ctx: AppContext, key: Key, value: string): void {
  ctx.db.prepare("INSERT INTO instance_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function settings(ctx: AppContext): { registration_mode: RegistrationMode; site_name: string; announcement: string } {
  return {
    registration_mode: getSetting(ctx, "registration_mode") as RegistrationMode,
    site_name: getSetting(ctx, "site_name"),
    announcement: getSetting(ctx, "announcement"),
  };
}
