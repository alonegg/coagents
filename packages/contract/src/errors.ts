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
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
