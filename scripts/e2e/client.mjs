// Minimal cookie-holding HTTPS client for acceptance runs against a deployed hub. No dependencies.
import assert from "node:assert/strict";

export class HubClient {
  constructor(base, label) {
    this.base = base.replace(/\/$/, "");
    this.label = label;
    this.cookies = new Map();
    this.csrf = "";
  }

  async call(method, path, body) {
    const headers = { "user-agent": `coagents-e2e/${this.label}` };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET") headers["x-csrf-token"] = this.csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    // Network failures are retried only when repeating is safe: reads, and writes with a request_id.
    const safe = method === "GET" || (body && typeof body === "object" && "request_id" in body);
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`${this.base}/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        break;
      } catch (err) {
        if (!safe || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/Max-Age=0/i.test(sc) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async expect(status, method, path, body) {
    const res = await this.call(method, path, body);
    assert.equal(res.status, status, `${this.label} ${method} ${path}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async login(username, password) {
    const s = await this.expect(201, "POST", "/session", { username, password });
    this.csrf = s.csrf_token;
    return s;
  }

  adopt(session) {
    this.csrf = session.csrf_token;
    return session;
  }
}

export function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function step(msg) {
  console.log(`ok - ${msg}`);
}

// Follows an SSE stream, calling onEvent(seq, data) for each new event and onControl(name, data)
// for ready/revoked. Returns { stop, done, cursor() }.
export function follow(url, headers, { onEvent, onControl }) {
  const abort = new AbortController();
  let cursor = 0;
  const done = (async () => {
    const res = await fetch(url, { headers: { accept: "text/event-stream", ...headers }, signal: abort.signal });
    if (!res.ok) {
      onControl?.("http", res.status);
      return;
    }
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = "message";
          let id;
          const data = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trim());
          }
          if (!data.length) continue;
          const parsed = JSON.parse(data.join("\n"));
          if (id !== undefined) {
            cursor = Number(id);
            onEvent?.(cursor, parsed);
          } else onControl?.(event, parsed);
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") throw err;
    }
    onControl?.("closed");
  })();
  return { stop: () => abort.abort(), done, cursor: () => cursor };
}

export function cookieHeader(client) {
  return { cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
}

export function waitFor(check, timeoutMs, label) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}
