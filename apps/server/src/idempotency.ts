import { actorKey, nowIso, type Actor, type AppContext } from "./context.js";
import { HttpError } from "./http-error.js";

export interface StoredResult {
  status: 200 | 201;
  body: unknown;
}

const RETENTION_MS = 24 * 3600_000;

// Runs fn at most once per (actor, request_id) in one immediate transaction. A retry with the same
// request_id returns the stored result; reusing a request_id for a different request is rejected.
// Failed writes are not stored, so retrying them re-executes against the current state.
export function idempotent(ctx: AppContext, actor: Actor, requestId: string, scope: string, fn: () => StoredResult): StoredResult {
  const key = actorKey(actor);
  return ctx.db.transaction((): StoredResult => {
    const prior = ctx.db
      .prepare("SELECT scope, status, body FROM idempotency WHERE actor_key = ? AND request_id = ?")
      .get(key, requestId) as { scope: string; status: 200 | 201; body: string } | undefined;
    if (prior) {
      if (prior.scope !== scope) throw new HttpError(422, "invalid_input", "request_id was already used for a different request");
      return { status: prior.status, body: JSON.parse(prior.body) as unknown };
    }
    const result = fn();
    ctx.db
      .prepare("INSERT INTO idempotency (actor_key, request_id, scope, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key, requestId, scope, result.status, JSON.stringify(result.body), nowIso(ctx));
    return result;
  }).immediate();
}

export function purgeIdempotency(ctx: AppContext): number {
  const cutoff = new Date(ctx.clock().getTime() - RETENTION_MS).toISOString();
  return ctx.db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(cutoff).changes;
}

// For writes whose preconditions must be recorded even when they fail: look up a stored result
// first, then run the check outside the transaction, then the write through idempotent().
export function priorResult(ctx: AppContext, actor: Actor, requestId: string, scope: string): StoredResult | undefined {
  const prior = ctx.db
    .prepare("SELECT scope, status, body FROM idempotency WHERE actor_key = ? AND request_id = ?")
    .get(actorKey(actor), requestId) as { scope: string; status: 200 | 201; body: string } | undefined;
  if (!prior) return undefined;
  if (prior.scope !== scope) throw new HttpError(422, "invalid_input", "request_id was already used for a different request");
  return { status: prior.status, body: JSON.parse(prior.body) as unknown };
}
