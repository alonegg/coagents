import { z } from "zod";

const RequestId = z.string().min(8).max(128);

// A due moment: a full ISO timestamp, or a plain date meaning the end of that day in the
// project's time zone. Stored as UTC.
export const DueInput = z.union([z.iso.datetime({ offset: true }), z.iso.date()]).nullable();

export const CreateMilestoneInput = z
  .object({ title: z.string().trim().min(1).max(200), criteria: z.string().max(20_000).default(""), due_at: DueInput.default(null), request_id: RequestId })
  .strict();

export const EditMilestoneInput = z
  .object({
    expected_version: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    criteria: z.string().max(20_000).optional(),
    due_at: DueInput.optional(),
    request_id: RequestId,
  })
  .strict();

// Scope changes always carry a reason so they can be traced later.
export const MilestoneScopeInput = z
  .object({
    expected_version: z.number().int().positive(),
    add_task_ids: z.array(z.string().max(64)).max(200).default([]),
    remove_task_ids: z.array(z.string().max(64)).max(200).default([]),
    reason: z.string().trim().min(1).max(2000),
    request_id: RequestId,
  })
  .strict();

export const MilestoneDecisionInput = z
  .object({ expected_version: z.number().int().positive(), note: z.string().trim().min(1).max(5000), request_id: RequestId })
  .strict();

export const DueChangeInput = z.object({ expected_version: z.number().int().positive(), due_at: DueInput, request_id: RequestId }).strict();

export interface MilestoneView {
  id: string;
  project_id: string;
  title: string;
  criteria: string;
  due_at: string | null;
  state: "open" | "achieved";
  overdue: boolean;
  confirmed_by: string | null;
  confirmed_at: string | null;
  confirm_note: string | null;
  version: number;
  counts: { total: number; todo: number; in_progress: number; blocked: number; review: number; done: number; overdue: number };
  created_at: string;
  updated_at: string;
}

// End of a calendar day in an IANA time zone, as a UTC instant.
export function endOfDayUtc(date: string, timeZone: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  // Start from the naive UTC instant for 23:59:59.999 and correct by the zone's offset at that time;
  // a second pass settles days where the offset changes.
  let t = Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  for (let i = 0; i < 2; i++) t = Date.UTC(y, m - 1, d, 23, 59, 59, 999) - offsetMs(t, timeZone);
  return new Date(t).toISOString();
}

function offsetMs(t: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(t / 1000) * 1000;
}

export function resolveDue(value: string | null, timeZone: string): string | null {
  if (value === null) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? endOfDayUtc(value, timeZone) : new Date(value).toISOString();
}
