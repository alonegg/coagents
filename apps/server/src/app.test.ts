import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDb, schemaVersion } from "./db.js";

describe("server skeleton", () => {
  it("reports health with the applied schema version", async () => {
    const db = openDb(":memory:");
    const res = await createApp(db).request("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "0.0.0", schema_version: 1 });
  });

  it("does not reapply migrations on reopen", () => {
    const path = join(mkdtempSync(join(tmpdir(), "coagents-")), "test.db");
    openDb(path).close();
    const db = openDb(path);
    expect(schemaVersion(db)).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });
});
