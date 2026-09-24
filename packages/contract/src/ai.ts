import { z } from "zod";

// Server-side model assistance (advisory only). The model never changes task state; its output is
// validated against these schemas and shown to people and agents as an unconfirmed suggestion.

export const AiSettingsInput = z
  .object({
    enabled: z.boolean().optional(),
    // Any OpenAI-compatible endpoint, e.g. https://api.openai.com/v1 or a local http://host:11434/v1.
    base_url: z.url({ protocol: /^https?$/ }).max(500).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    // Write-only: never returned by any API.
    api_key: z.string().trim().min(1).max(500).optional(),
    clear_api_key: z.boolean().optional(),
    daily_limit: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

export interface AiSettingsView {
  enabled: boolean;
  base_url: string;
  model: string;
  api_key_set: boolean;
  // Last four characters, so a maintainer can tell which key is configured.
  api_key_hint: string | null;
  // Model calls per project per rolling 24 hours.
  daily_limit: number;
}

export const AiKind = z.enum(["prereview", "briefing", "digest", "criteria_draft", "routing"]);
export type AiKind = z.infer<typeof AiKind>;

const Line = z.string().max(1000);
const Lines = z.array(Line).max(12);

export const PreReviewOutput = z
  .object({
    overall: z.enum(["looks_complete", "has_gaps", "insufficient"]),
    criteria: z
      .array(
        z
          .object({
            criterion_id: z.string().max(10),
            assessment: z.enum(["supported", "weak", "unsupported", "contradicted"]),
            note: Line,
          })
          .strict(),
      )
      .max(30),
    concerns: Lines,
    suggested_review_note: z.string().max(2000),
  })
  .strict();
export type PreReviewOutput = z.infer<typeof PreReviewOutput>;

export const BriefingOutput = z
  .object({
    state: z.string().max(1000),
    done: Lines,
    open_items: Lines,
    review_feedback: Lines,
    risks: Lines,
    next_actions: Lines,
  })
  .strict();
export type BriefingOutput = z.infer<typeof BriefingOutput>;

export const DigestOutput = z
  .object({
    headline: z.string().max(500),
    highlights: Lines,
    needs_attention: Lines,
    decisions: Lines,
    conflicts: Lines,
  })
  .strict();
export type DigestOutput = z.infer<typeof DigestOutput>;

export const CriteriaDraftOutput = z
  .object({
    criteria: z.array(z.object({ text: z.string().max(1000), why: z.string().max(500) }).strict()).max(12),
    questions: Lines,
  })
  .strict();
export type CriteriaDraftOutput = z.infer<typeof CriteriaDraftOutput>;

// Who could take a task (assign), unblock it, or receive a handoff.
export const RoutingPurpose = z.enum(["assign", "unblock", "handoff"]);
export type RoutingPurpose = z.infer<typeof RoutingPurpose>;

export const RoutingOutput = z
  .object({
    candidates: z.array(z.object({ user_id: z.string().max(64), fit: z.enum(["high", "medium", "low"]), reason: z.string().max(600) }).strict()).max(3),
    note: z.string().max(800),
  })
  .strict();
export type RoutingOutput = z.infer<typeof RoutingOutput>;
// Stored form: candidates are checked against the project's members and carry their names.
export interface RoutingView {
  purpose: RoutingPurpose;
  candidates: { user_id: string; name: string; role: string; fit: "high" | "medium" | "low"; reason: string }[];
  note: string;
}

export const AI_OUTPUT_SCHEMAS = {
  prereview: PreReviewOutput,
  briefing: BriefingOutput,
  digest: DigestOutput,
  criteria_draft: CriteriaDraftOutput,
  routing: RoutingOutput,
} as const;

export const RoutingInput = z.object({ purpose: RoutingPurpose, request_id: z.string().min(8).max(128).optional() }).strict();

// Asking a member for help on a task: an event plus a notification to that person.
export const HelpRequestInput = z
  .object({ user_id: z.string().min(1).max(64), note: z.string().trim().min(1).max(2000), request_id: z.string().min(8).max(128) })
  .strict();

export interface AiOutputView<T = unknown> {
  id: string;
  kind: AiKind;
  subject_id: string;
  status: "pending" | "ready" | "failed" | "skipped";
  output: T | null;
  error: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  // False when the task or project changed after this output was generated.
  current: boolean;
}

export const AI_NOTICE = "AI 生成的建议，未经人工确认，可能有误；不代表验收结论。";
