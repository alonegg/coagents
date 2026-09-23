import type { ArtifactKind, ArtifactVersionView, ArtifactView } from "@coagents/contract";
import { audit } from "./audit.js";
import { wakeAuthChanged } from "./bus.js";
import { nowIso, type Actor, type AppContext } from "./context.js";
import { appendEvent } from "./events.js";
import { isPreviewable } from "./files.js";
import { HttpError, invalid, notAllowed, notFound } from "./http-error.js";
import { newId } from "./ids.js";
import { enqueueIndex, reindexTitle } from "./search.js";
import { artifactReadable, isManager, type Viewer } from "./visibility.js";

interface ArtifactRow {
  id: string;
  project_id: string;
  task_id: string | null;
  title: string;
  summary: string;
  kind: ArtifactKind;
  status: "draft" | "published" | "deleted";
  visibility: "project" | "restricted";
  current_version: number | null;
  author_id: string;
  author_name: string;
  source_author: string | null;
  source_at: string | null;
  imported_by: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
  has_draft: number;
}

interface VersionRow {
  id: string;
  artifact_id: string;
  state: "draft" | "published";
  version: number | null;
  revision: number;
  body: string | null;
  file_id: string | null;
  url: string | null;
  created_by: string;
  created_at: string;
  published_at: string | null;
  filename: string | null;
  media_type: string | null;
  size: number | null;
  storage_key: string | null;
}

const SELECT_ARTIFACT = `SELECT a.*, u.display_name AS author_name,
  EXISTS (SELECT 1 FROM artifact_versions d WHERE d.artifact_id = a.id AND d.state = 'draft') AS has_draft
  FROM artifacts a JOIN users u ON u.id = a.author_id`;

const SELECT_VERSION = `SELECT v.*, f.filename, f.media_type, f.size, f.storage_key
  FROM artifact_versions v LEFT JOIN stored_files f ON f.id = v.file_id`;

const revisionConflict = () =>
  new HttpError(409, "version_conflict", "The draft was changed elsewhere; reload it and apply your edits again");

function toView(r: ArtifactRow): ArtifactView {
  return {
    id: r.id,
    project_id: r.project_id,
    task_id: r.task_id,
    title: r.title,
    summary: r.summary,
    kind: r.kind,
    status: r.status,
    visibility: r.visibility,
    current_version: r.current_version,
    author: { id: r.author_id, display_name: r.author_name },
    source_author: r.source_author,
    source_at: r.source_at,
    imported_by: r.imported_by,
    imported_at: r.imported_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    has_draft: r.has_draft === 1,
  };
}

function versionView(v: VersionRow): ArtifactVersionView {
  return {
    id: v.id,
    state: v.state,
    version: v.version,
    revision: v.revision,
    body: v.body,
    url: v.url,
    file: v.file_id
      ? { id: v.file_id, filename: v.filename!, media_type: v.media_type!, size: v.size!, previewable: isPreviewable(v.media_type!) }
      : null,
    created_by: v.created_by,
    created_at: v.created_at,
    published_at: v.published_at,
  };
}

// Loads an artifact the viewer may read; anything else is indistinguishable from missing.
export function readableArtifact(ctx: AppContext, projectId: string, viewer: Viewer, artifactId: string): ArtifactRow {
  const r = artifactReadable("a", viewer);
  const row = ctx.db
    .prepare(`${SELECT_ARTIFACT} WHERE a.id = ? AND a.project_id = ? AND (${r.sql})`)
    .get(artifactId, projectId, ...r.params) as ArtifactRow | undefined;
  if (!row) throw notFound();
  return row;
}

function canEdit(row: ArtifactRow, viewer: Viewer): boolean {
  return isManager(viewer) || row.author_id === viewer.userId;
}

export function listArtifacts(ctx: AppContext, projectId: string, viewer: Viewer, filter: { taskId?: string | undefined; deleted?: boolean }): ArtifactView[] {
  if (filter.deleted) {
    if (!isManager(viewer)) throw notAllowed();
    return (ctx.db.prepare(`${SELECT_ARTIFACT} WHERE a.project_id = ? AND a.status = 'deleted' ORDER BY a.updated_at DESC`).all(projectId) as ArtifactRow[]).map(toView);
  }
  const r = artifactReadable("a", viewer);
  const rows = ctx.db
    .prepare(`${SELECT_ARTIFACT} WHERE a.project_id = ? AND (${r.sql}) ${filter.taskId ? "AND a.task_id = ?" : ""} ORDER BY a.updated_at DESC`)
    .all(projectId, ...r.params, ...(filter.taskId ? [filter.taskId] : [])) as ArtifactRow[];
  return rows.map(toView);
}

// Published versions are visible with the artifact; the working draft only to its editors.
export function getArtifact(ctx: AppContext, projectId: string, viewer: Viewer, artifactId: string): ArtifactView & { versions: ArtifactVersionView[] } {
  const row = readableArtifact(ctx, projectId, viewer, artifactId);
  const versions = (ctx.db.prepare(`${SELECT_VERSION} WHERE v.artifact_id = ? ORDER BY v.state = 'draft' DESC, v.version DESC`).all(artifactId) as VersionRow[])
    .filter((v) => v.state === "published" || canEdit(row, viewer))
    .map(versionView);
  return { ...toView(row), versions };
}

export function versionForDownload(ctx: AppContext, projectId: string, viewer: Viewer, artifactId: string, versionId: string): VersionRow {
  const row = readableArtifact(ctx, projectId, viewer, artifactId);
  const v = ctx.db.prepare(`${SELECT_VERSION} WHERE v.id = ? AND v.artifact_id = ?`).get(versionId, artifactId) as VersionRow | undefined;
  if (!v || !v.storage_key || (v.state === "draft" && !canEdit(row, viewer))) throw notFound();
  return v;
}

interface Content {
  body?: string | undefined;
  file_id?: string | undefined;
  url?: string | undefined;
}

function checkContent(ctx: AppContext, projectId: string, actor: Actor, kind: ArtifactKind, c: Content): { body: string | null; file_id: string | null; url: string | null } {
  const given = [c.body !== undefined, c.file_id !== undefined, c.url !== undefined].filter(Boolean).length;
  if (given !== 1) throw invalid("Give exactly one of body, file_id or url");
  if (kind === "markdown" && c.body === undefined) throw invalid("A markdown artifact needs body");
  if (kind === "link" && c.url === undefined) throw invalid("A link artifact needs url");
  if (kind === "file") {
    if (c.file_id === undefined) throw invalid("A file artifact needs file_id from an upload");
    const f = ctx.db.prepare("SELECT 1 FROM stored_files WHERE id = ? AND project_id = ? AND uploaded_by = ?").get(c.file_id, projectId, actor.userId);
    if (!f) throw invalid("file_id is not an upload of yours in this project");
  }
  return { body: c.body ?? null, file_id: c.file_id ?? null, url: c.url ?? null };
}

export interface CreateArtifact extends Content {
  title: string;
  summary: string;
  kind: ArtifactKind;
  task_id?: string | undefined;
  source_author?: string | undefined;
  source_at?: string | undefined;
}

// New artifacts start as a private draft; nothing is announced until publication.
export function createArtifact(ctx: AppContext, projectId: string, actor: Actor, viewer: Viewer, input: CreateArtifact): ArtifactView & { versions: ArtifactVersionView[] } {
  if (input.task_id && !ctx.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND project_id = ?").get(input.task_id, projectId)) {
    throw invalid("task_id is not a task of this project");
  }
  const content = checkContent(ctx, projectId, actor, input.kind, input);
  const imported = input.source_author !== undefined || input.source_at !== undefined;
  const id = newId("art");
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO artifacts (id, project_id, task_id, title, summary, kind, status, visibility, author_id, source_author, source_at, imported_by, imported_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', 'project', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectId, input.task_id ?? null, input.title, input.summary, input.kind, actor.userId, input.source_author ?? null, input.source_at ?? null, imported ? actor.userId : null, imported ? now : null, now, now);
  ctx.db
    .prepare(`INSERT INTO artifact_versions (id, artifact_id, state, revision, body, file_id, url, created_by, created_at) VALUES (?, ?, 'draft', 1, ?, ?, ?, ?, ?)`)
    .run(newId("atv"), id, content.body, content.file_id, content.url, actor.userId, now);
  return getArtifact(ctx, projectId, viewer, id);
}

// expected_revision 0 starts a new working draft from the current published version.
export function updateDraft(
  ctx: AppContext,
  projectId: string,
  actor: Actor,
  viewer: Viewer,
  artifactId: string,
  expectedRevision: number,
  patch: Content & { title?: string | undefined; summary?: string | undefined },
): ArtifactView & { versions: ArtifactVersionView[] } {
  const row = readableArtifact(ctx, projectId, viewer, artifactId);
  if (!canEdit(row, viewer)) throw notAllowed("Only the author or a project admin can edit this artifact");
  const now = nowIso(ctx);
  const draft = ctx.db.prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? AND state = 'draft'").get(artifactId) as VersionRow | undefined;
  const hasContent = patch.body !== undefined || patch.file_id !== undefined || patch.url !== undefined;
  const content = hasContent ? checkContent(ctx, projectId, actor, row.kind, patch) : undefined;
  if (!draft) {
    if (expectedRevision !== 0) throw revisionConflict();
    const base = ctx.db.prepare("SELECT body, file_id, url FROM artifact_versions WHERE artifact_id = ? AND version = ?").get(artifactId, row.current_version) as Content;
    const c = content ?? { body: base.body ?? null, file_id: base.file_id ?? null, url: base.url ?? null };
    ctx.db
      .prepare(`INSERT INTO artifact_versions (id, artifact_id, state, revision, body, file_id, url, created_by, created_at) VALUES (?, ?, 'draft', 1, ?, ?, ?, ?, ?)`)
      .run(newId("atv"), artifactId, c.body ?? null, c.file_id ?? null, c.url ?? null, actor.userId, now);
  } else {
    if (draft.revision !== expectedRevision) throw revisionConflict();
    if (content) {
      ctx.db
        .prepare("UPDATE artifact_versions SET body = ?, file_id = ?, url = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .run(content.body, content.file_id, content.url, draft.id, expectedRevision);
    } else {
      ctx.db.prepare("UPDATE artifact_versions SET revision = revision + 1 WHERE id = ? AND revision = ?").run(draft.id, expectedRevision);
    }
  }
  ctx.db
    .prepare("UPDATE artifacts SET title = COALESCE(?, title), summary = COALESCE(?, summary), updated_at = ? WHERE id = ?")
    .run(patch.title ?? null, patch.summary ?? null, now, artifactId);
  if (patch.title !== undefined || patch.summary !== undefined) reindexTitle(ctx, artifactId);
  return getArtifact(ctx, projectId, viewer, artifactId);
}

// Publishing turns the draft into the next immutable version in one transaction.
export function publishArtifact(ctx: AppContext, projectId: string, actor: Actor, viewer: Viewer, artifactId: string, expectedRevision: number): ArtifactView & { versions: ArtifactVersionView[] } {
  const row = readableArtifact(ctx, projectId, viewer, artifactId);
  if (!canEdit(row, viewer)) throw notAllowed("Only the author or a project admin can publish this artifact");
  const draft = ctx.db.prepare("SELECT id, revision FROM artifact_versions WHERE artifact_id = ? AND state = 'draft'").get(artifactId) as { id: string; revision: number } | undefined;
  if (!draft) throw new HttpError(409, "version_conflict", "There is no draft to publish");
  if (draft.revision !== expectedRevision) throw revisionConflict();
  const next = (ctx.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM artifact_versions WHERE artifact_id = ?").get(artifactId) as { n: number }).n;
  const now = nowIso(ctx);
  ctx.db.prepare("UPDATE artifact_versions SET state = 'published', version = ?, published_at = ? WHERE id = ?").run(next, now, draft.id);
  ctx.db.prepare("UPDATE artifacts SET status = 'published', current_version = ?, updated_at = ? WHERE id = ?").run(next, now, artifactId);
  enqueueIndex(ctx, draft.id);
  appendEvent(ctx, projectId, actor, {
    kind: next === 1 ? "artifact.published" : "artifact.version_published",
    subjectType: "artifact",
    subjectId: artifactId,
    summary: next === 1 ? `发布成果「${row.title}」` : `发布成果「${row.title}」第 ${next} 版`,
    data: { version: next, version_id: draft.id, ...(row.task_id ? { task_id: row.task_id } : {}) },
  });
  return getArtifact(ctx, projectId, viewer, artifactId);
}

// Owners and admins choose project-wide or a named list of current members. The change applies
// at once to lists, versions, files, events and search.
export function setAccess(ctx: AppContext, projectId: string, actor: Actor, viewer: Viewer, artifactId: string, visibility: "project" | "restricted", userIds: string[]): ArtifactView {
  if (!isManager(viewer)) throw notAllowed("Only owners and admins can change who sees an artifact");
  const row = readableArtifact(ctx, projectId, viewer, artifactId);
  const members = new Set((ctx.db.prepare("SELECT user_id FROM memberships WHERE project_id = ?").all(projectId) as { user_id: string }[]).map((m) => m.user_id));
  const unknown = userIds.filter((u) => !members.has(u));
  if (unknown.length) throw invalid("The restricted list may only contain current project members");
  ctx.db.prepare("DELETE FROM artifact_grants WHERE artifact_id = ?").run(artifactId);
  if (visibility === "restricted") {
    const ins = ctx.db.prepare("INSERT INTO artifact_grants (artifact_id, user_id) VALUES (?, ?)");
    for (const u of new Set(userIds)) ins.run(artifactId, u);
  }
  ctx.db.prepare("UPDATE artifacts SET visibility = ?, updated_at = ? WHERE id = ?").run(visibility, nowIso(ctx), artifactId);
  audit(ctx, { projectId, actorUserId: actor.userId, action: "artifact.access", objectType: "artifact", objectId: artifactId, detail: { visibility, members: userIds.length } });
  if (row.status === "published") {
    appendEvent(ctx, projectId, actor, { kind: "artifact.access_changed", subjectType: "artifact", subjectId: artifactId, summary: `调整成果「${row.title}」的可见范围`, data: { visibility } });
  }
  wakeAuthChanged();
  return toView(readableArtifact(ctx, projectId, viewer, artifactId));
}

export function listGrants(ctx: AppContext, artifactId: string): string[] {
  return (ctx.db.prepare("SELECT user_id FROM artifact_grants WHERE artifact_id = ?").all(artifactId) as { user_id: string }[]).map((g) => g.user_id);
}

// Soft delete closes reading, versions and downloads; the record stays for admins and audit.
export function deleteArtifact(ctx: AppContext, projectId: string, actor: Actor, viewer: Viewer, artifactId: string): void {
  const row = readableArtifact(ctx, projectId, viewer, artifactId);
  if (!canEdit(row, viewer)) throw notAllowed("Only the author or a project admin can delete this artifact");
  const now = nowIso(ctx);
  ctx.db.prepare("UPDATE artifacts SET status = 'deleted', deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?").run(now, actor.userId, now, artifactId);
  audit(ctx, { projectId, actorUserId: actor.userId, action: "artifact.delete", objectType: "artifact", objectId: artifactId });
  if (row.status === "published") {
    appendEvent(ctx, projectId, actor, { kind: "artifact.deleted", subjectType: "artifact", subjectId: artifactId, summary: `删除成果「${row.title}」`, data: {} });
  }
  wakeAuthChanged();
}

// Submissions reference published versions of live artifacts in the same project.
export function checkSubmissionVersions(ctx: AppContext, projectId: string, versionIds: string[]): void {
  for (const id of versionIds) {
    const ok = ctx.db
      .prepare(
        `SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
         WHERE v.id = ? AND v.state = 'published' AND a.project_id = ? AND a.status = 'published'`,
      )
      .get(id, projectId);
    if (!ok) throw invalid(`${id} is not a published artifact version of this project`);
  }
}

// What a viewer learns about the versions a submission points to: titles only when readable.
export function describeVersions(ctx: AppContext, projectId: string, viewer: Viewer, versionIds: string[]): { version_id: string; artifact_id: string | null; title: string | null; version: number | null; readable: boolean }[] {
  const r = artifactReadable("a", viewer);
  return versionIds.map((id) => {
    const row = ctx.db
      .prepare(
        `SELECT a.id AS artifact_id, a.title, v.version FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
         WHERE v.id = ? AND a.project_id = ? AND (${r.sql})`,
      )
      .get(id, projectId, ...r.params) as { artifact_id: string; title: string; version: number } | undefined;
    return row ? { version_id: id, ...row, readable: true } : { version_id: id, artifact_id: null, title: null, version: null, readable: false };
  });
}
