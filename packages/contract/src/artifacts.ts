import { z } from "zod";

// OD-03, provisional (2026-09-23): shared by the Hub and the API.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const PREVIEW_MEDIA_TYPES = [
  "text/markdown",
  "text/plain",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export const ArtifactKind = z.enum(["markdown", "file", "link"]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;
export const ArtifactVisibility = z.enum(["project", "restricted"]);

const Title = z.string().trim().min(1).max(200);
const Summary = z.string().max(2000);
const RequestId = z.string().min(8).max(128);
const HttpUrl = z.url({ protocol: /^https?$/ });
const IsoDate = z.iso.datetime({ offset: true }).or(z.iso.date());

// Content of one version: exactly one of body (markdown), file_id (uploaded file) or url (link).
export const ArtifactContent = z.object({
  body: z.string().max(1_000_000).optional(),
  file_id: z.string().max(64).optional(),
  url: HttpUrl.optional(),
});

export const CreateArtifactInput = z
  .object({
    title: Title,
    summary: Summary.default(""),
    kind: ArtifactKind,
    task_id: z.string().max(64).optional(),
    // Import provenance: the original author and date as declared; unknown stays unknown.
    source_author: z.string().trim().max(120).optional(),
    source_at: IsoDate.optional(),
    request_id: RequestId,
  })
  .extend(ArtifactContent.shape)
  .strict();

export const UpdateDraftInput = z
  .object({
    expected_revision: z.number().int().min(0),
    title: Title.optional(),
    summary: Summary.optional(),
    request_id: RequestId,
  })
  .extend(ArtifactContent.shape)
  .strict();

export const PublishInput = z.object({ expected_revision: z.number().int().min(1), request_id: RequestId }).strict();

export const AccessInput = z
  .object({
    visibility: ArtifactVisibility,
    user_ids: z.array(z.string().max(64)).max(200).default([]),
    request_id: RequestId,
  })
  .strict();

export interface ArtifactVersionView {
  id: string;
  state: "draft" | "published";
  version: number | null;
  revision: number;
  body: string | null;
  url: string | null;
  file: { id: string; filename: string; media_type: string; size: number; previewable: boolean } | null;
  created_by: string;
  created_at: string;
  published_at: string | null;
}

export interface ArtifactView {
  id: string;
  project_id: string;
  task_id: string | null;
  title: string;
  summary: string;
  kind: ArtifactKind;
  status: "draft" | "published" | "deleted";
  visibility: "project" | "restricted";
  current_version: number | null;
  author: { id: string; display_name: string };
  source_author: string | null;
  source_at: string | null;
  imported_by: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
  has_draft: boolean;
}
