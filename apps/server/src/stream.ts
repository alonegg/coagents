import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { waitForWake } from "./bus.js";
import type { AppContext } from "./context.js";

export const HEARTBEAT_MS = 15_000;

export interface StreamSpec<T> {
  topics: string[];
  // Re-checked before every delivery; false ends the stream with a "revoked" event.
  authorize: () => boolean;
  // Items after the cursor, oldest first, already filtered by current permissions.
  fetch: (cursor: number) => { items: T[]; cursorOf: (item: T) => number };
  cursor: number;
  eventName: string;
  onDelivered?: (lastCursor: number, items: T[]) => void;
}

// Server-sent events from committed rows. Each wake-up (or heartbeat) re-authorizes, then sends
// everything after the last delivered cursor. SSE ids let clients resume with Last-Event-ID.
export function sse<T>(c: Context, _ctx: AppContext, spec: StreamSpec<T>) {
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    let cursor = spec.cursor;
    await stream.writeSSE({ event: "ready", data: JSON.stringify({ cursor }) });
    while (!abort.signal.aborted) {
      if (!spec.authorize()) {
        await stream.writeSSE({ event: "revoked", data: JSON.stringify({ reason: "access_revoked" }) });
        break;
      }
      const { items, cursorOf } = spec.fetch(cursor);
      if (items.length) {
        for (const item of items) {
          await stream.writeSSE({ event: spec.eventName, id: String(cursorOf(item)), data: JSON.stringify(item) });
        }
        cursor = cursorOf(items[items.length - 1]!);
        spec.onDelivered?.(cursor, items);
        continue;
      }
      await stream.write(": ping\n\n");
      await waitForWake(spec.topics, HEARTBEAT_MS, abort.signal);
    }
    await stream.close();
  });
}

export function resumeCursor(c: Context, fallback: number): number {
  const raw = c.req.query("cursor") ?? c.req.header("last-event-id");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
