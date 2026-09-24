import { AccessInput, CreateArtifactInput, PublishInput, UpdateDraftInput } from "@coagents/contract";
import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";
import { requireActive } from "../access.js";
import {
  createArtifact,
  deleteArtifact,
  getArtifact,
  listArtifacts,
  listGrants,
  publishArtifact,
  setAccess,
  updateDraft,
  versionForDownload,
} from "../artifacts.js";
import type { Env } from "../auth.js";
import type { AppContext } from "../context.js";
import { cleanFilename, contentDisposition, isPreviewable, openStoredFile, storeUpload } from "../files.js";
import { notAllowed } from "../http-error.js";
import { idempotent } from "../idempotency.js";
import { parseBody } from "../validate.js";
import { isManager } from "../visibility.js";
import { actorFor, checkPermission, requireHuman } from "./work.js";

export function artifactRoutes(ctx: AppContext): Hono<Env> {
  const r = new Hono<Env>();

  function resolve(c: Parameters<typeof actorFor>[1]) {
    const resolved = actorFor(ctx, c);
    return { ...resolved, viewer: { userId: resolved.actor.userId, role: resolved.access.role } };
  }

  function writer(c: Parameters<typeof actorFor>[1]) {
    const x = resolve(c);
    checkPermission(x, "artifact.write_own");
    requireActive(x.access);
    return x;
  }

  r.get("/:id/artifacts", (c) => {
    const { access, viewer } = resolve(c);
    return c.json({
      artifacts: listArtifacts(ctx, access.projectId, viewer, { taskId: c.req.query("task_id"), deleted: c.req.query("deleted") === "1" }),
    });
  });

  r.post("/:id/artifacts", async (c) => {
    const input = await parseBody(c, CreateArtifactInput);
    const { actor, access, viewer } = writer(c);
    const { request_id, ...rest } = input;
    const res = idempotent(ctx, actor, request_id, `artifact.create:${access.projectId}`, () => ({
      status: 201,
      body: createArtifact(ctx, access.projectId, actor, viewer, rest),
    }));
    return c.json(res.body as object, res.status);
  });

  r.get("/:id/artifacts/:aid", (c) => {
    const { access, viewer } = resolve(c);
    const art = getArtifact(ctx, access.projectId, viewer, c.req.param("aid"));
    return c.json(isManager(viewer) ? { ...art, restricted_to: listGrants(ctx, art.id) } : art);
  });

  r.patch("/:id/artifacts/:aid/draft", async (c) => {
    const input = await parseBody(c, UpdateDraftInput);
    const { actor, access, viewer } = writer(c);
    const { request_id, expected_revision, ...patch } = input;
    const res = idempotent(ctx, actor, request_id, `artifact.draft:${c.req.param("aid")}`, () => ({
      status: 200,
      body: updateDraft(ctx, access.projectId, actor, viewer, c.req.param("aid"), expected_revision, patch),
    }));
    return c.json(res.body as object, res.status);
  });

  r.post("/:id/artifacts/:aid/publish", async (c) => {
    const input = await parseBody(c, PublishInput);
    const { actor, access, viewer } = writer(c);
    const res = idempotent(ctx, actor, input.request_id, `artifact.publish:${c.req.param("aid")}`, () => ({
      status: 200,
      body: publishArtifact(ctx, access.projectId, actor, viewer, c.req.param("aid"), input.expected_revision),
    }));
    return c.json(res.body as object, res.status);
  });

  r.put("/:id/artifacts/:aid/access", async (c) => {
    const input = await parseBody(c, AccessInput);
    const x = resolve(c);
    requireHuman(x, "artifact.access");
    checkPermission(x, "artifact.manage_all");
    requireActive(x.access);
    const res = idempotent(ctx, x.actor, input.request_id, `artifact.access:${c.req.param("aid")}`, () => ({
      status: 200,
      body: setAccess(ctx, x.access.projectId, x.actor, x.viewer, c.req.param("aid"), input.visibility, input.user_ids),
    }));
    return c.json(res.body as object, res.status);
  });

  r.delete("/:id/artifacts/:aid", (c) => {
    const { actor, access, viewer } = writer(c);
    deleteArtifact(ctx, access.projectId, actor, viewer, c.req.param("aid"));
    return c.body(null, 204);
  });

  // Upload the raw bytes; the name comes from X-Filename. Files are uploaded from the Hub by people only.
  r.post("/:id/files", async (c) => {
    const x = writer(c);
    requireHuman(x, "artifact.upload");
    const filename = cleanFilename(decodeURIComponent(c.req.header("x-filename") ?? ""));
    const file = await storeUpload(ctx, x.access.projectId, x.actor.userId, filename, c.req.raw.body);
    return c.json({ ...file, previewable: isPreviewable(file.media_type) }, 201);
  });

  // Files are served only here, after the same artifact check as everything else. Only previewable
  // types are shown inline, sandboxed; everything else downloads as opaque bytes.
  r.get("/:id/artifacts/:aid/versions/:vid/file", (c) => {
    const { access, viewer } = resolve(c);
    const v = versionForDownload(ctx, access.projectId, viewer, c.req.param("aid"), c.req.param("vid"));
    const inline = c.req.query("inline") === "1" && isPreviewable(v.media_type!);
    const { stream, size } = openStoredFile(ctx, v.storage_key!);
    c.header("Content-Type", inline ? (v.media_type!.startsWith("text/") ? "text/plain; charset=utf-8" : v.media_type!) : "application/octet-stream");
    c.header("Content-Length", String(size));
    c.header("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", v.filename!));
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "private, no-store");
    if (v.media_type !== "application/pdf") c.header("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    return honoStream(c, async (out) => {
      for await (const chunk of stream as AsyncIterable<Buffer>) await out.write(chunk);
    });
  });


  return r;
}
