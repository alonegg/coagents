import type { Hono } from "hono";
import { createApp } from "./app.js";
import type { AppContext } from "./context.js";
import { openDb } from "./db.js";
import { createUser } from "./users.js";

export const PUBLIC_URL = "https://hub.test";
export const PASSWORD = "correct horse battery";

export interface TestEnv {
  ctx: AppContext;
  app: Hono;
  advance(ms: number): void;
}

export function testEnv(): TestEnv {
  let now = Date.parse("2026-09-23T00:00:00Z");
  const ctx: AppContext = {
    db: openDb(":memory:"),
    clock: () => new Date(now),
    config: { publicUrl: PUBLIC_URL, sessionTtlHours: 24 },
  };
  return { ctx, app: createApp(ctx), advance: (ms) => void (now += ms) };
}

// A cookie-holding browser that sends the CSRF token it was given on sign-in.
export class Browser {
  private cookies = new Map<string, string>();
  csrf = "";

  constructor(private readonly app: Hono, readonly userAgent = "TestBrowser/1.0") {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const h: Record<string, string> = { "user-agent": this.userAgent, ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (this.csrf && !("x-csrf-token" in headers)) h["x-csrf-token"] = this.csrf;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await this.app.request(`${PUBLIC_URL}${path}`, {
      method,
      headers: h,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const [name, value] = pair!.split("=");
      if (/Max-Age=0/i.test(sc) || value === "") this.cookies.delete(name!);
      else this.cookies.set(name!, value!);
    }
    return res;
  }

  async json<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await this.req(method, path, body);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  async login(username: string, password = PASSWORD): Promise<number> {
    const res = await this.json("POST", "/v1/session", { username, password });
    if (res.status === 201) this.csrf = res.body.csrf_token;
    return res.status;
  }

  sessionCookie(): string | undefined {
    return this.cookies.get("coagents_session");
  }
}

export async function seedUser(env: TestEnv, username: string, maintainer = false): Promise<Browser> {
  await createUser(env.ctx, {
    username,
    displayName: username,
    timezone: "Asia/Shanghai",
    password: PASSWORD,
    instanceRole: maintainer ? "maintainer" : "member",
  });
  const b = new Browser(env.app);
  await b.login(username);
  return b;
}
