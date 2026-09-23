#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

// The backend listens on loopback by default; HTTPS is terminated by the reverse proxy.
const dataDir = process.env.COAGENTS_DATA_DIR ?? join(process.cwd(), ".coagents-data");
const host = process.env.COAGENTS_HOST ?? "127.0.0.1";
const port = Number(process.env.COAGENTS_PORT ?? 8787);

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = openDb(join(dataDir, "coagents.db"));

serve({ fetch: createApp(db).fetch, hostname: host, port }, (info) => {
  console.log(`coagents server listening on http://${info.address}:${info.port}`);
});
