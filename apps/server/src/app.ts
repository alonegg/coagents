import { Hono } from "hono";
import { schemaVersion, type Db } from "./db.js";

export const SERVER_VERSION = "0.0.0";

export function createApp(db: Db): Hono {
  const app = new Hono();

  app.get("/v1/health", (c) =>
    c.json({ status: "ok", version: SERVER_VERSION, schema_version: schemaVersion(db) }),
  );

  return app;
}
