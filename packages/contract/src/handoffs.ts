import { z } from "zod";
import { NextStepItems } from "./protocol.js";

const RequestId = z.string().min(8).max(128);
const Text = z.string().trim().min(1).max(20_000);
const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "full commit id");

// A git remote reduced to host/path so ssh and https forms of the same repository compare equal.
// Credentials, scheme, trailing .git and slashes are dropped.
export function normalizeRemote(url: string): string {
  let s = url.trim();
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  s = s.replace(/\.git\/?$/i, "").replace(/\/+$/, "");
  const slash = s.indexOf("/");
  return slash < 0 ? s.toLowerCase() : `${s.slice(0, slash).toLowerCase().replace(/:\d+$/, "")}${s.slice(slash)}`;
}

// What the sender's Connector found in its working copy. Client-attested: the server records it
// but cannot see the code.
export const SenderGit = z
  .object({
    repo_identity: z.string().min(1).max(300),
    branch: z.string().max(250),
    commit: Sha,
    dirty: z.boolean(),
    pushed: z.boolean(),
  })
  .strict();
export type SenderGit = z.infer<typeof SenderGit>;

export const ReceiverCheck = z
  .object({
    repo_identity: z.string().min(1).max(300),
    has_commit: z.boolean(),
    dirty: z.boolean(),
  })
  .strict();
export type ReceiverCheck = z.infer<typeof ReceiverCheck>;

export const PrepareHandoffInput = z
  .object({
    lease_token: z.string().min(16).max(256).optional(),
    summary: Text,
    // Either prose or a list; a list is also rendered into next_steps for older readers.
    next_steps: Text.optional(),
    next_step_items: NextStepItems.optional(),
    risks: z.string().max(20_000).optional(),
    target_user_id: z.string().max(64).optional(),
    git: SenderGit.optional(),
    artifact_version_ids: z.array(z.string().max(64)).max(50).default([]),
    request_id: RequestId,
  })
  .strict()
  .refine((v) => v.next_steps !== undefined || v.next_step_items !== undefined, { message: "next_steps or next_step_items is required" });

export const AcceptHandoffInput = z.object({ check: ReceiverCheck.optional(), request_id: RequestId }).strict();

export interface HandoffView {
  id: string;
  project_id: string;
  task_id: string;
  task_title: string;
  state: "pending" | "accepted" | "cancelled";
  from: { user_id: string; display_name: string; holder_kind: "user" | "client"; author_kind: "human" | "agent"; device_id: string };
  target_user_id: string | null;
  summary: string;
  next_steps: string;
  next_step_items: string[];
  risks: string | null;
  git: SenderGit | null;
  artifacts: { version_id: string; artifact_id: string | null; title: string | null; version: number | null; readable: boolean }[];
  last_check: { ok: boolean; reasons: string[]; warnings: string[]; checked_at: string; device_id: string } | null;
  created_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
}
