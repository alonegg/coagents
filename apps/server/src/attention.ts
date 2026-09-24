import { INTERRUPT_KINDS } from "@coagents/contract";
import type { AppContext } from "./context.js";

// People's attention is the scarce resource. Notifications an agent causes for one person count
// against that person's budget in the project (rolling 24 hours); past it they are kept but muted.

export function interruptLimit(ctx: AppContext, projectId: string): number {
  return (ctx.db.prepare("SELECT agent_interrupt_limit AS n FROM projects WHERE id = ?").get(projectId) as { n: number } | undefined)?.n ?? 0;
}

export function agentInterruptsInLastDay(ctx: AppContext, projectId: string, recipientId: string): number {
  const since = new Date(ctx.clock().getTime() - 24 * 3600_000).toISOString();
  return (
    ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications n JOIN events e ON e.seq = n.event_seq
         WHERE n.project_id = ? AND n.recipient_id = ? AND n.muted = 0 AND e.actor_client_id IS NOT NULL
           AND n.kind IN (${INTERRUPT_KINDS.map(() => "?").join(", ")}) AND n.created_at > ?`,
      )
      .get(projectId, recipientId, ...INTERRUPT_KINDS, since) as { n: number }
  ).n;
}

export function overBudget(ctx: AppContext, projectId: string, recipientId: string): boolean {
  return agentInterruptsInLastDay(ctx, projectId, recipientId) >= interruptLimit(ctx, projectId);
}

// Why an agent may not write right now: the whole project or this one connection is paused.
export function agentPause(ctx: AppContext, projectId: string, clientId: string): "project" | "connection" | null {
  const p = ctx.db.prepare("SELECT agents_paused_at FROM projects WHERE id = ?").get(projectId) as { agents_paused_at: string | null } | undefined;
  if (p?.agents_paused_at) return "project";
  const c = ctx.db.prepare("SELECT paused_at FROM clients WHERE id = ?").get(clientId) as { paused_at: string | null } | undefined;
  return c?.paused_at ? "connection" : null;
}
