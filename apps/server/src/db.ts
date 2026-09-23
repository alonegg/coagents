import Database from "better-sqlite3";

export type Db = Database.Database;

// Ordered, append-only list of schema migrations. Never edit an applied entry; add a new one.
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE instance_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`,
];

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function schemaVersion(db: Db): number {
  return db.pragma("user_version", { simple: true }) as number;
}
