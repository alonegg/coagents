import { randomUUID } from "node:crypto";

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const RETRIES = 3;
const TIMEOUT_MS = 20_000;

// HTTPS client for the team service. Certificate verification is Node's default and is never
// disabled. Writes carry a request_id and are retried with the same id after network failures, so a
// lost response cannot duplicate a write.
export class ServiceClient {
  constructor(
    readonly server: string,
    private readonly token?: string,
    private readonly userAgent = "coagents-connector/0.1",
  ) {}

  async call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const payload = body && method !== "GET" && !("request_id" in body) && path.startsWith("/projects/")
      ? { ...body, request_id: `mcp-${randomUUID()}` }
      : body;
    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.server}/v1${path}`, {
          method,
          headers: {
            "user-agent": this.userAgent,
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            ...(payload ? { "content-type": "application/json" } : {}),
          },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        lastErr = err;
        // Idempotent retry only makes sense for reads and writes carrying a request_id.
        if (method !== "GET" && !(payload && "request_id" in payload)) break;
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      const text = await res.text();
      const data = text ? (JSON.parse(text) as unknown) : null;
      if (!res.ok) {
        const e = (data as { error?: { code: string; message: string } } | null)?.error;
        throw new ServiceError(res.status, e?.code ?? "unknown", e?.message ?? `HTTP ${res.status}`);
      }
      return data as T;
    }
    const cause = lastErr as { cause?: { code?: string }; message?: string } | undefined;
    throw new ServiceError(0, cause?.cause?.code ?? "network", `Cannot reach ${this.server}: ${cause?.cause?.code ?? cause?.message ?? "network error"}`);
  }
}
