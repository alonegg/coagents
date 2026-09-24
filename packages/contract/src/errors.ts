import { z } from "zod";

// Machine-readable error codes shared by the HTTP API and MCP tools.
export const ErrorCode = z.enum([
  "unauthenticated",
  "forbidden_or_not_found",
  "invalid_input",
  "version_conflict",
  "task_already_held",
  "task_not_claimable",
  "lease_invalid",
  "decision_already_superseded",
  "project_not_bound",
  "project_archived",
  "rate_limited",
  "csrf_failed",
  "username_taken",
  "invitation_invalid",
  "already_member",
  "not_allowed",
  "authorization_pending",
  "expired_token",
  "handoff_blocked",
  "handoff_check_failed",
  "registration_pending",
  "registration_rejected",
  "registration_closed",
  "password_change_required",
  "ai_unavailable",
  "agents_paused",
  "attention_budget_exceeded",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
