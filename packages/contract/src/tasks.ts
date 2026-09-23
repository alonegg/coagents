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

// A lapsed lease does not move the card (PRD section 7), so an in-progress task whose lease
// expired stays in progress but may be claimed by someone else.
export function canClaim(status: TaskStatus, leaseActive: boolean): boolean {
  return status === "todo" || status === "blocked" || (status === "in_progress" && !leaseActive);
}

const Title = z.string().trim().min(1).max(200);
const LongText = z.string().max(20_000);

export const CreateTaskInput = z
  .object({
    title: Title,
    description: LongText.default(""),
    acceptance_criteria: LongText.default(""),
    assignee_id: Id.nullable().default(null),
    request_id: RequestId,
  })
  .strict();

export const EditTaskInput = z
  .object({
    expected_version: z.number().int().positive(),
    title: Title.optional(),
    description: LongText.optional(),
    acceptance_criteria: LongText.optional(),
    assignee_id: Id.nullable().optional(),
    request_id: RequestId,
  })
  .strict();

// Humans in the Hub prove holding by their session and device; agents must present the lease token.
export const LeaseRef = z.object({ lease_token: LeaseToken.optional(), request_id: RequestId });
export const HttpClaimInput = z.object({ request_id: RequestId }).strict();
export const HttpRenewInput = LeaseRef.strict();
export const HttpReleaseInput = LeaseRef.extend({ note: Body.optional() }).strict();
export const HttpSubmitInput = LeaseRef.extend({
  summary: Body,
  artifact_version_ids: z.array(Id).max(50).default([]),
  evidence: Body.optional(),
}).strict();

export const ReviewInput = z
  .object({ expected_version: z.number().int().positive(), note: Body.optional(), request_id: RequestId })
  .strict();
// Rejecting, reopening and terminating a lease always need a reason.
export const ReasonedReviewInput = z
  .object({ expected_version: z.number().int().positive(), reason: Body, request_id: RequestId })
  .strict();

export const HttpBlockerInput = z
  .object({ body: Body, task_id: Id.optional(), lease_token: LeaseToken.optional(), request_id: RequestId })
  .strict();

export const DecisionInput = z.object({ body: Body, supersedes_id: Id.optional(), request_id: RequestId }).strict();

export const HolderView = z.object({
  kind: z.enum(["user", "client"]),
  id: z.string(),
  user_id: z.string(),
  display_name: z.string(),
  device_id: z.string(),
  lease_until: z.string(),
  lease_active: z.boolean(),
});

export const TaskView = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptance_criteria: z.string(),
  assignee_id: z.string().nullable(),
  status: TaskStatus,
  holder: HolderView.nullable(),
  milestone_id: z.string().nullable(),
  due_at: z.string().nullable(),
  overdue: z.boolean(),
  version: z.number(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type TaskView = z.infer<typeof TaskView>;

export const ClaimResult = z.object({ task: TaskView, lease_token: z.string(), lease_until: z.string() });
export type ClaimResult = z.infer<typeof ClaimResult>;

export const EventView = z.object({
  seq: z.number(),
  id: z.string(),
  project_id: z.string(),
  kind: z.string(),
  actor: z.object({ user_id: z.string(), display_name: z.string(), client_id: z.string().nullable(), device_id: z.string().nullable() }),
  subject_type: z.string(),
  subject_id: z.string(),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type EventView = z.infer<typeof EventView>;

export const EventPage = z.object({ events: z.array(EventView), next_cursor: z.number(), has_more: z.boolean() });
export type EventPage = z.infer<typeof EventPage>;
