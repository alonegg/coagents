export interface SseMessage {
  event: string;
  id?: string;
  data: string;
}

// Minimal text/event-stream parser over a fetch body.
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const msg: SseMessage = { event: "message", data: "" };
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        const sep = line.indexOf(":");
        const field = sep < 0 ? line : line.slice(0, sep);
        const value = sep < 0 ? "" : line.slice(sep + 1).replace(/^ /, "");
        if (field === "event") msg.event = value;
        else if (field === "id") msg.id = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) {
        msg.data = data.join("\n");
        yield msg;
      }
    }
  }
}

export type StreamState = "connecting" | "live" | "reconnecting" | "revoked" | "stopped";

export interface EventStreamOptions {
  url: (cursor: number) => string;
  headers: Record<string, string>;
  cursor: number;
  onEvent: (seq: number, data: unknown) => void;
  onState?: (state: StreamState, detail?: string) => void;
  maxBackoffMs?: number;
}

// Keeps one SSE connection open, resuming from the last delivered seq after any drop.
// Stops for good when the server says the access was revoked (event or 401/404).
export class EventStream {
  private abort = new AbortController();
  cursor: number;
  state: StreamState = "connecting";

  constructor(private readonly o: EventStreamOptions) {
    this.cursor = o.cursor;
  }

  private set(state: StreamState, detail?: string) {
    this.state = state;
    this.o.onState?.(state, detail);
  }

  async run(): Promise<void> {
    let backoff = 500;
    while (!this.abort.signal.aborted) {
      try {
        const res = await fetch(this.o.url(this.cursor), { headers: { accept: "text/event-stream", ...this.o.headers }, signal: this.abort.signal });
        if (res.status === 401 || res.status === 404) {
          this.set("revoked", `HTTP ${res.status}`);
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        for await (const msg of readSse(res.body)) {
          if (msg.event === "ready") {
            this.set("live");
            backoff = 500;
          } else if (msg.event === "revoked") {
            this.set("revoked", msg.data);
            return;
          } else if (msg.id !== undefined) {
            const seq = Number(msg.id);
            if (seq > this.cursor) {
              this.cursor = seq;
              this.o.onEvent(seq, JSON.parse(msg.data) as unknown);
            }
          }
        }
        throw new Error("stream ended");
      } catch (err) {
        if (this.abort.signal.aborted) break;
        this.set("reconnecting", (err as Error).message);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, this.o.maxBackoffMs ?? 30_000);
      }
    }
    this.set("stopped");
  }

  stop(): void {
    this.abort.abort();
  }
}
