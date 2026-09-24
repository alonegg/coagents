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
  `
  CREATE TABLE handoffs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'cancelled')),
    from_holder_kind TEXT NOT NULL CHECK (from_holder_kind IN ('user', 'client')),
    from_holder_id TEXT NOT NULL,
    from_user_id TEXT NOT NULL REFERENCES users(id),
    from_device_id TEXT NOT NULL REFERENCES devices(id),
    target_user_id TEXT REFERENCES users(id),
    summary TEXT NOT NULL,
    next_steps TEXT NOT NULL,
    risks TEXT,
    git TEXT,
    artifact_version_ids TEXT NOT NULL,
    last_check TEXT,
    created_at TEXT NOT NULL,
    accepted_at TEXT,
    accepted_by TEXT REFERENCES users(id),
    cancelled_at TEXT
  ) STRICT;
  CREATE INDEX handoffs_by_task ON handoffs(task_id, created_at);
  CREATE UNIQUE INDEX one_pending_handoff_per_task ON handoffs(task_id) WHERE state = 'pending';
  `,
  `
  CREATE TABLE milestones (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    criteria TEXT NOT NULL,
    due_at TEXT,
    state TEXT NOT NULL CHECK (state IN ('open', 'achieved')),
    confirmed_by TEXT REFERENCES users(id),
    confirmed_at TEXT,
    confirm_note TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX milestones_by_project ON milestones(project_id);
  CREATE INDEX tasks_by_milestone ON tasks(milestone_id);

  -- One row per indexed artifact version. text keeps the original extracted text for snippets;
  -- the FTS table holds the CJK-segmented form used for matching.
  CREATE TABLE search_docs (
    artifact_version_id TEXT PRIMARY KEY REFERENCES artifact_versions(id),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    version INTEGER NOT NULL,
    index_state TEXT NOT NULL CHECK (index_state IN ('pending', 'ready', 'unsupported', 'failed')),
    text TEXT NOT NULL DEFAULT '',
    pages TEXT,
    error TEXT,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX search_docs_by_artifact ON search_docs(artifact_id);
  CREATE VIRTUAL TABLE search_fts USING fts5(title, body, artifact_version_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
  `,
  `
  ALTER TABLE projects ADD COLUMN deleted_at TEXT;
  ALTER TABLE projects ADD COLUMN deleted_by TEXT REFERENCES users(id);
  CREATE INDEX events_by_seq_project ON events(seq DESC, project_id);
  `,
  `
  ALTER TABLE users ADD COLUMN email TEXT;
  ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN last_login_at TEXT;

  -- Self-service applications. A user row exists only after a maintainer approves.
  CREATE TABLE registrations (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL,
    note TEXT NOT NULL,
    timezone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL,
    decided_by TEXT REFERENCES users(id),
    decided_at TEXT,
    decision_note TEXT,
    user_id TEXT REFERENCES users(id)
  ) STRICT;
  CREATE UNIQUE INDEX one_pending_registration_per_username ON registrations(username) WHERE status = 'pending';
  CREATE INDEX registrations_by_status ON registrations(status, created_at);
  `,
  `
  -- Agent protocol 2: acceptance checklist, structured evidence, next-step lists.
  ALTER TABLE tasks ADD COLUMN criteria TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tasks ADD COLUMN criteria_next INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE task_submissions ADD COLUMN evidence_items TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE task_submissions ADD COLUMN criteria_snapshot TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE handoffs ADD COLUMN next_step_items TEXT NOT NULL DEFAULT '[]';
  `,
  `
  -- Advisory model output (pre-review, briefings, digests) and a ledger of every model call.
  ALTER TABLE projects ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE ai_outputs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL CHECK (kind IN ('prereview', 'briefing', 'digest')),
    subject_id TEXT NOT NULL,
    input_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed', 'skipped')),
    output TEXT,
    error TEXT,
    model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (kind, subject_id, input_key)
  ) STRICT;
  CREATE INDEX ai_outputs_by_subject ON ai_outputs(kind, subject_id, created_at);
  CREATE TABLE ai_calls (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    requested_by TEXT,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
    input_chars INTEGER NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    latency_ms INTEGER,
    error TEXT,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX ai_calls_by_project ON ai_calls(project_id, created_at);
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
