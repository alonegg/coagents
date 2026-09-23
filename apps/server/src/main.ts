#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DisplayName, Password, TimeZone, Username } from "@coagents/contract";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import type { AppContext } from "./context.js";
import { openDb } from "./db.js";
import { hubStatic } from "./hub-static.js";
import { drainIndexQueue, enqueueIndex, resumeIndexing } from "./search.js";
import { createUser, disableUser, resetPassword, userCount } from "./users.js";

const USAGE = `Usage:
  coagents-server serve
  coagents-server setup --username <name> --display-name <name> [--timezone <IANA>] < password
  coagents-server reset-password --username <name> < password
  coagents-server reindex
  coagents-server disable-user --username <name>

Environment: COAGENTS_DATA_DIR, COAGENTS_PUBLIC_URL, COAGENTS_HOST, COAGENTS_PORT, COAGENTS_HUB_DIR`;

function context(): AppContext {
  const dataDir = process.env.COAGENTS_DATA_DIR ?? join(process.cwd(), ".coagents-data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    db: openDb(join(dataDir, "coagents.db")),
    clock: () => new Date(),
    config: {
      publicUrl: (process.env.COAGENTS_PUBLIC_URL ?? "http://127.0.0.1:8787").replace(/\/$/, ""),
      sessionTtlHours: 24 * 30,
      leaseMinutes: Number(process.env.COAGENTS_LEASE_MINUTES ?? 30),
      filesDir: join(dataDir, "files"),
      ...(process.env.COAGENTS_BUILD ? { build: process.env.COAGENTS_BUILD } : {}),
      ...(process.env.COAGENTS_BACKUP_DIR ? { backupDir: process.env.COAGENTS_BACKUP_DIR } : {}),
    },
  };
}

// Passwords come from stdin so they never appear in argv or shell history.
function readPassword(): string {
  const pw = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  return Password.parse(pw);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: { username: { type: "string" }, "display-name": { type: "string" }, timezone: { type: "string" } },
  });
  const ctx = context();

  switch (command) {
    case "serve": {
      const host = process.env.COAGENTS_HOST ?? "127.0.0.1";
      const port = Number(process.env.COAGENTS_PORT ?? 8787);
      const hubDir = process.env.COAGENTS_HUB_DIR;
      resumeIndexing(ctx);
      serve({ fetch: createApp(ctx, hubDir ? hubStatic(hubDir) : undefined).fetch, hostname: host, port }, (info) => {
        console.log(`coagents server listening on http://${info.address}:${info.port}`);
      });
      return;
    }
    case "setup": {
      if (userCount(ctx) > 0) throw new Error("Setup already done: this instance has users");
      const user = await createUser(ctx, {
        username: Username.parse(values.username),
        displayName: DisplayName.parse(values["display-name"]),
        timezone: TimeZone.parse(values.timezone ?? "UTC"),
        password: readPassword(),
        instanceRole: "maintainer",
      });
      console.log(`created maintainer ${user.username} (${user.id})`);
      return;
    }
    case "reindex": {
      // Rebuilds the search index from managed artifact content (e.g. after restoring a backup).
      const ids = ctx.db.prepare("SELECT id FROM artifact_versions WHERE state = 'published'").all() as { id: string }[];
      for (const { id } of ids) enqueueIndex(ctx, id);
      await drainIndexQueue(ctx);
      console.log(`reindexed ${ids.length} published versions`);
      return;
    }
    case "disable-user": {
      const user = disableUser(ctx, Username.parse(values.username));
      console.log(`disabled ${user.username}; sessions and agent connections revoked`);
      return;
    }
    case "reset-password": {
      const user = await resetPassword(ctx, Username.parse(values.username), readPassword());
      console.log(`password reset for ${user.username}; all sessions revoked`);
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
