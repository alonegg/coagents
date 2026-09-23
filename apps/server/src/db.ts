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
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL,
    assignee_id TEXT REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'blocked', 'review', 'done')),
    holder_kind TEXT CHECK (holder_kind IN ('user', 'client')),
    holder_id TEXT,
    holder_user_id TEXT REFERENCES users(id),
    holder_device_id TEXT REFERENCES devices(id),
    lease_token_hash TEXT,
    lease_until TEXT,
    milestone_id TEXT,
    due_at TEXT,
    version INTEGER NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((holder_kind IS NULL) = (lease_until IS NULL))
  ) STRICT;
  CREATE INDEX tasks_by_project ON tasks(project_id, status);

  CREATE TABLE task_submissions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    summary TEXT NOT NULL,
    artifact_version_ids TEXT NOT NULL,
    evidence TEXT,
    submitted_by_user TEXT NOT NULL REFERENCES users(id),
    submitted_by_client TEXT,
    created_at TEXT NOT NULL,
    outcome TEXT CHECK (outcome IN ('accepted', 'rejected')),
    reviewed_by TEXT REFERENCES users(id),
    review_note TEXT,
    reviewed_at TEXT
  ) STRICT;
  CREATE INDEX submissions_by_task ON task_submissions(task_id, created_at);

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL,
    actor_user_id TEXT NOT NULL REFERENCES users(id),
    actor_client_id TEXT,
    actor_device_id TEXT,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX events_by_project ON events(project_id, seq);

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    event_seq INTEGER NOT NULL REFERENCES events(seq),
    body TEXT NOT NULL,
    supersedes_id TEXT UNIQUE REFERENCES decisions(id),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE cursors (
    consumer_kind TEXT NOT NULL CHECK (consumer_kind IN ('device', 'client')),
    consumer_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    last_seen_seq INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (consumer_kind, consumer_id, project_id)
  ) STRICT;

  CREATE TABLE idempotency (
    actor_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_key, request_id)
  ) STRICT;
  CREATE INDEX idempotency_by_age ON idempotency(created_at);
  `,
  `
  CREATE TABLE clients (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT NOT NULL REFERENCES devices(id),
    label TEXT NOT NULL,
    scopes TEXT NOT NULL,
    token_hash TEXT UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    verified_at TEXT,
    revoked_at TEXT
  ) STRICT;
  CREATE INDEX clients_by_project ON clients(project_id);

  CREATE TABLE device_codes (
    id TEXT PRIMARY KEY,
    device_code_hash TEXT NOT NULL UNIQUE,
    user_code TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    client_label TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    approved_by TEXT REFERENCES users(id),
    approved_at TEXT,
    client_id TEXT REFERENCES clients(id),
    consumed_at TEXT,
    denied_at TEXT
  ) STRICT;
  `,
  `
  ALTER TABLE cursors ADD COLUMN delivered_seq INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL REFERENCES users(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    event_seq INTEGER NOT NULL REFERENCES events(seq),
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    read_at TEXT,
    UNIQUE (recipient_id, event_seq)
  ) STRICT;
  CREATE INDEX notifications_by_recipient ON notifications(recipient_id, created_at);
  `,
  `
  CREATE TABLE stored_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    storage_key TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    uploaded_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    task_id TEXT REFERENCES tasks(id),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('markdown', 'file', 'link')),
    status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'deleted')),
    visibility TEXT NOT NULL CHECK (visibility IN ('project', 'restricted')),
    current_version INTEGER,
    author_id TEXT NOT NULL REFERENCES users(id),
    source_author TEXT,
    source_at TEXT,
    imported_by TEXT REFERENCES users(id),
    imported_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    deleted_by TEXT REFERENCES users(id)
  ) STRICT;
  CREATE INDEX artifacts_by_project ON artifacts(project_id, updated_at);

  CREATE TABLE artifact_versions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    state TEXT NOT NULL CHECK (state IN ('draft', 'published')),
    version INTEGER,
    revision INTEGER NOT NULL,
    body TEXT,
    file_id TEXT REFERENCES stored_files(id),
    url TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    published_at TEXT,
    CHECK ((state = 'published') = (version IS NOT NULL)),
    CHECK ((body IS NOT NULL) + (file_id IS NOT NULL) + (url IS NOT NULL) = 1)
  ) STRICT;
  CREATE UNIQUE INDEX one_draft_per_artifact ON artifact_versions(artifact_id) WHERE state = 'draft';
  CREATE UNIQUE INDEX artifact_version_numbers ON artifact_versions(artifact_id, version) WHERE version IS NOT NULL;
  -- Published versions are immutable.
  CREATE TRIGGER published_versions_immutable BEFORE UPDATE ON artifact_versions
    WHEN OLD.state = 'published' BEGIN SELECT RAISE(ABORT, 'published artifact versions are immutable'); END;

  CREATE TABLE artifact_grants (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (artifact_id, user_id)
  ) STRICT;
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
