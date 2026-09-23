import type { ErrorCode } from "@coagents/contract";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// Non-members get the same answer whether or not the resource exists (PRD section 10).
export const notFound = () => new HttpError(404, "forbidden_or_not_found", "Not found or not accessible");
export const notAllowed = (message = "This action is not allowed for your role") =>
  new HttpError(403, "not_allowed", message);
export const invalid = (message: string) => new HttpError(400, "invalid_input", message);
