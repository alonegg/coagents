import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, sessionStillValid, type Env } from "../auth.js";
import type { AppContext } from "../context.js";
import { listNotifications, markDelivered, markRead, unreadCount, type NotificationView } from "../notifications.js";
import { resumeCursor, sse } from "../stream.js";
import { parseBody } from "../validate.js";

export function notificationRoutes(ctx: AppContext): Hono<Env> {
  const r = new Hono<Env>();

  r.get("/", (c) => {
    const auth = requireAuth(c);
    const notifications = listNotifications(ctx, auth.user.id, { unreadOnly: c.req.query("unread") === "1", limit: 50 });
    return c.json({ notifications, unread: unreadCount(ctx, auth.user.id) });
  });

  r.post("/read", async (c) => {
    const auth = requireAuth(c);
    const input = await parseBody(c, z.object({ ids: z.union([z.array(z.string()).max(200), z.literal("all")]) }).strict());
    markRead(ctx, auth.user.id, input.ids);
    return c.json({ unread: unreadCount(ctx, auth.user.id) });
  });

  // Pushes new notifications for this user; delivery is recorded when written to the stream.
  r.get("/stream", (c) => {
    const auth = requireAuth(c);
    const userId = auth.user.id;
    return sse<NotificationView & { unread: number }>(c, ctx, {
      topics: [`user:${userId}`],
      cursor: resumeCursor(c, 0),
      eventName: "notification",
      authorize: () => sessionStillValid(ctx, auth.sessionId),
      fetch: (cursor) => ({
        items: listNotifications(ctx, userId, { unreadOnly: false, limit: 50 })
          .filter((n) => n.event_seq > cursor && !n.muted)
          .reverse()
          .map((n) => ({ ...n, unread: unreadCount(ctx, userId) })),
        cursorOf: (n) => n.event_seq,
      }),
      onDelivered: (_seq, items) => markDelivered(ctx, userId, items.map((n) => n.id)),
    });
  });

  return r;
}
