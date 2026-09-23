import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_FILE_BYTES, PREVIEW_MEDIA_TYPES } from "@coagents/contract";
import { nowIso, type AppContext } from "./context.js";
import { HttpError, invalid } from "./http-error.js";
import { newId } from "./ids.js";

// The stored media type comes from the extension, never from the client's claim. Anything not in
// this map is served only as an opaque download.
const EXTENSION_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};

export function mediaTypeFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return EXTENSION_TYPES[ext] ?? "application/octet-stream";
}

export function isPreviewable(mediaType: string): boolean {
  return (PREVIEW_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

export function cleanFilename(raw: string): string {
  const name = raw.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 200);
  if (!name || name === "." || name === "..") throw invalid("A file name is required");
  return name;
}

export interface StoredFile {
  id: string;
  filename: string;
  media_type: string;
  size: number;
  sha256: string;
}

// Streams the upload to a temp file, enforcing the size limit while reading, then moves it into
// place and records it. A failed upload leaves nothing behind.
export async function storeUpload(
  ctx: AppContext,
  projectId: string,
  userId: string,
  filename: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<StoredFile> {
  if (!body) throw invalid("Empty upload");
  const id = newId("fil");
  const dir = join(ctx.config.filesDir, projectId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${id}.part`);
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_FILE_BYTES) throw new HttpError(413, "invalid_input", `File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      hash.update(chunk);
      chunks.push(chunk);
    }
    if (size === 0) throw invalid("Empty upload");
    writeFileSync(tmp, Buffer.concat(chunks), { mode: 0o600 });
    const storageKey = `${projectId}/${id}`;
    renameSync(tmp, join(ctx.config.filesDir, storageKey));
    const file: StoredFile = { id, filename, media_type: mediaTypeFor(filename), size, sha256: hash.digest("hex") };
    ctx.db
      .prepare(
        `INSERT INTO stored_files (id, project_id, storage_key, filename, media_type, size, sha256, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, storageKey, filename, file.media_type, size, file.sha256, userId, nowIso(ctx));
    return file;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing written yet
    }
    throw err;
  }
}

export function openStoredFile(ctx: AppContext, storageKey: string): { stream: NodeJS.ReadableStream; size: number } {
  const path = join(ctx.config.filesDir, storageKey);
  return { stream: createReadStream(path), size: statSync(path).size };
}

// RFC 6266 / 5987 filename for Content-Disposition, safe for non-ASCII names.
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
