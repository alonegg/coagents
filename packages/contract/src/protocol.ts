import { z } from "zod";

// Version of the agent collaboration protocol (docs/AGENT_PROTOCOL.md). The server reports it on
// /v1/agent/me; a Connector that needs newer server features checks it before relying on them.
// 1: Connector 0.1 (free-text exchange). 2: acceptance checklist, structured evidence, typed
// blockers, next-step lists, author kinds.
export const PROTOCOL_VERSION = 2;
// Oldest Connector the server still serves fully; older ones are told to upgrade.
export const MIN_CONNECTOR_VERSION = "0.1.0";

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

// Who wrote a piece of project content: a person in the Hub or an agent through its Connector.
// Agents read both as untrusted data; the kind tells them whose word it is.
export const AuthorKind = z.enum(["human", "agent"]);
export type AuthorKind = z.infer<typeof AuthorKind>;
export const authorKind = (clientId: string | null | undefined): AuthorKind => (clientId ? "agent" : "human");

// Acceptance checklist. Ids are assigned by the server (c1, c2, ...) and never reused within a task,
// so evidence can point at a criterion even after the list is edited.
export const MAX_CRITERIA = 30;
export const CriterionId = z.string().regex(/^c[1-9]\d{0,2}$/, "criterion id like c1");
export const Criterion = z.object({ id: CriterionId, text: z.string().trim().min(1).max(1000) }).strict();
export type Criterion = z.infer<typeof Criterion>;
export const CriterionInput = z.object({ id: CriterionId.optional(), text: z.string().trim().min(1).max(1000) }).strict();
export type CriterionInput = z.infer<typeof CriterionInput>;
export const CriteriaInput = z.array(CriterionInput).max(MAX_CRITERIA);

// Keeps the ids of criteria that are still present, numbers new ones after the highest id ever
// used (`next`), and rejects ids the task does not have.
export function assignCriterionIds(existing: Criterion[], input: CriterionInput[], next: number): { criteria: Criterion[]; next: number } | { error: string } {
  const known = new Set(existing.map((c) => c.id));
  const seen = new Set<string>();
  const out: Criterion[] = [];
  let n = next;
  for (const c of input) {
    if (c.id !== undefined) {
      if (!known.has(c.id)) return { error: `Unknown criterion id ${c.id}` };
      if (seen.has(c.id)) return { error: `Duplicate criterion id ${c.id}` };
      seen.add(c.id);
      out.push({ id: c.id, text: c.text });
    } else {
      out.push({ id: `c${n++}`, text: c.text });
    }
  }
  if (n > 999) return { error: "Too many criteria were created for this task" };
  return { criteria: out, next: n };
}

// Evidence attached to a submission. Each item may point at one criterion.
//   test:     ref = the command or suite that ran; result required
//   commit:   ref = full commit id
//   artifact: ref = a published artifact version id (added to the submission's versions)
//   link:     ref = http(s) URL
//   review:   a check done by reading or trying the result; result required
//   note:     free explanation, e.g. why a criterion does not apply
export const EvidenceKind = z.enum(["test", "commit", "artifact", "link", "review", "note"]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;
export const EvidenceResult = z.enum(["pass", "fail", "partial", "not_applicable"]);
export type EvidenceResult = z.infer<typeof EvidenceResult>;
export const MAX_EVIDENCE_ITEMS = 50;

export const EvidenceItem = z
  .object({
    criterion_id: CriterionId.optional(),
    kind: EvidenceKind,
    result: EvidenceResult.optional(),
    ref: z.string().trim().min(1).max(500).optional(),
    detail: z.string().trim().min(1).max(4000).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const need = (ok: boolean, message: string) => ok || ctx.addIssue({ code: "custom", message });
    switch (e.kind) {
      case "test":
        need(!!e.ref, "test evidence needs ref: the command or suite that ran");
        need(!!e.result, "test evidence needs result");
        break;
      case "commit":
        need(!!e.ref && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(e.ref), "commit evidence needs ref: a full commit id");
        break;
      case "artifact":
        need(!!e.ref && /^[A-Za-z0-9_-]{1,64}$/.test(e.ref), "artifact evidence needs ref: an artifact version id");
        break;
      case "link":
        need(!!e.ref && /^https?:\/\/\S+$/i.test(e.ref), "link evidence needs ref: an http(s) URL");
        break;
      case "review":
        need(!!e.result, "review evidence needs result");
        need(!!e.detail, "review evidence needs detail: what was checked");
        break;
      case "note":
        need(!!e.detail, "note evidence needs detail");
        break;
    }
  });
export type EvidenceItem = z.infer<typeof EvidenceItem>;
export const EvidenceItems = z.array(EvidenceItem).max(MAX_EVIDENCE_ITEMS);

export type CoverageStatus = "pass" | "fail" | "partial" | "not_applicable" | "unverified" | "missing";
export interface CriterionCoverage {
  criterion_id: string;
  text: string;
  status: CoverageStatus;
  evidence: number;
}

// How the evidence covers each criterion, for the reviewer and for the submitting agent.
// Any fail wins; then partial; pass needs at least one pass; not_applicable only when every result
// says so; items without a result leave the criterion unverified; no items at all is missing.
export function criteriaCoverage(criteria: Criterion[], items: EvidenceItem[]): CriterionCoverage[] {
  return criteria.map((c) => {
    const mine = items.filter((e) => e.criterion_id === c.id);
    const results = mine.map((e) => e.result).filter((r): r is EvidenceResult => r !== undefined);
    const status: CoverageStatus =
      mine.length === 0
        ? "missing"
        : results.includes("fail")
          ? "fail"
          : results.includes("partial")
            ? "partial"
            : results.includes("pass")
              ? "pass"
              : results.length > 0 && results.every((r) => r === "not_applicable")
                ? "not_applicable"
                : "unverified";
    return { criterion_id: c.id, text: c.text, status, evidence: mine.length };
  });
}

// Blockers say what kind of help they need and, when known, from whom or which task.
export const BlockerKind = z.enum(["needs_decision", "needs_access", "needs_input", "dependency", "external", "other"]);
export type BlockerKind = z.infer<typeof BlockerKind>;

export const MAX_NEXT_STEPS = 30;
export const NextStepItems = z.array(z.string().trim().min(1).max(2000)).min(1).max(MAX_NEXT_STEPS);
