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
    const res = await fetch(`${this.base}/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
