import { EventEmitter } from "node:events";

// In-process wake-ups for open streams. Streams always re-read committed rows from the database;
// a wake-up only says "look again". Emitting inside a better-sqlite3 transaction is safe because
// listeners continue asynchronously, after the synchronous transaction has committed.
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function wakeProject(projectId: string): void {
  bus.emit(`project:${projectId}`);
}

export function wakeUser(userId: string): void {
  bus.emit(`user:${userId}`);
}

// Any revocation (session, device, client, membership, role) wakes every stream to re-authorize.
export function wakeAuthChanged(): void {
  bus.emit("auth");
}

export function waitForWake(topics: string[], timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      for (const t of [...topics, "auth"]) bus.off(t, done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    for (const t of [...topics, "auth"]) bus.on(t, done);
    signal.addEventListener("abort", done);
  });
}
