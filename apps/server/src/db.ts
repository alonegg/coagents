import Database from "better-sqlite3";

export type Db = Database.Database;

// Ordered, append-only list of schema migrations. Never edit an applied entry; add a new one.
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE instance_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`,
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    timezone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    instance_role TEXT NOT NULL CHECK (instance_role IN ('maintainer', 'member')),
    auth_state TEXT NOT NULL DEFAULT 'active' CHECK (auth_state IN ('active', 'disabled')),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('browser', 'connector')),
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL REFERENCES devices(id),
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived')),
    timezone TEXT NOT NULL,
    due_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE memberships (
    project_id TEXT NOT NULL REFERENCES projects(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'contributor', 'viewer')),
    joined_at TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id)
  ) STRICT;
  -- Exactly one owner per project: at most one enforced here, at least one by the transfer transaction.
  CREATE UNIQUE INDEX one_owner_per_project ON memberships(project_id) WHERE role = 'owner';
  CREATE INDEX memberships_by_user ON memberships(user_id);

  CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    role TEXT NOT NULL CHECK (role IN ('admin', 'contributor', 'viewer')),
    target_username TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    accepted_by TEXT REFERENCES users(id),
    revoked_at TEXT
  ) STRICT;

  CREATE TABLE ownership_transfers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    from_user_id TEXT NOT NULL REFERENCES users(id),
    to_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    outcome TEXT CHECK (outcome IN ('accepted', 'cancelled'))
  ) STRICT;
  CREATE UNIQUE INDEX one_open_transfer ON ownership_transfers(project_id) WHERE resolved_at IS NULL;

  CREATE TABLE audit_records (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    actor_user_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX audit_by_project ON audit_records(project_id, created_at);
  `,
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
