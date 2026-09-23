import { z } from "zod";

export const TaskStatus = z.enum(["todo", "in_progress", "blocked", "review", "done"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const RequestId = z.string().min(8).max(128);
const Id = z.string().min(1).max(64);
const LeaseToken = z.string().min(16).max(256);
const Body = z.string().trim().min(1).max(20_000);

export const ClaimTaskInput = z.object({ task_id: Id, request_id: RequestId }).strict();

export const ReleaseTaskInput = z
  .object({ task_id: Id, lease_token: LeaseToken, note: Body.optional(), request_id: RequestId })
  .strict();

export const SubmitTaskInput = z
  .object({
    task_id: Id,
    lease_token: LeaseToken,
    summary: Body,
    artifact_version_ids: z.array(Id).max(50).optional(),
    evidence: Body.optional(),
    request_id: RequestId,
  })
  .strict();

// A blocker tied to a task moves it to blocked and needs the holder's lease;
// a blocker without a task only records an event.
export const PublishBlockerInput = z
  .object({ body: Body, task_id: Id.optional(), lease_token: LeaseToken.optional(), request_id: RequestId })
  .strict()
  .refine((v) => (v.task_id === undefined) === (v.lease_token === undefined), {
    message: "task_id and lease_token must be given together",
  });

export type TaskAction = "claim" | "release" | "block" | "submit" | "accept" | "reject" | "reopen";

// Allowed status transitions per semantic action (PRD section 7). There is no generic status update.
export const TASK_TRANSITIONS: Record<TaskAction, { from: readonly TaskStatus[]; to: TaskStatus }> = {
  claim: { from: ["todo", "blocked"], to: "in_progress" },
  release: { from: ["in_progress"], to: "todo" },
  block: { from: ["in_progress"], to: "blocked" },
  submit: { from: ["in_progress"], to: "review" },
  accept: { from: ["review"], to: "done" },
  reject: { from: ["review"], to: "todo" },
  reopen: { from: ["done"], to: "todo" },
};

export function nextStatus(action: TaskAction, current: TaskStatus): TaskStatus | null {
  const rule = TASK_TRANSITIONS[action];
  return rule.from.includes(current) ? rule.to : null;
}
