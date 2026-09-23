import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { Hono } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

// Serves the built Hub. Routing is hash-based, so unknown paths fall back to index.html.
export function hubStatic(dir: string): Hono {
  const app = new Hono();
  app.get("*", async (c) => {
    const rel = normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, "");
    if (rel.startsWith("..")) return c.notFound();
    const isAsset = rel.startsWith("assets/");
    const file = rel === "" || !extname(rel) ? "index.html" : rel;
    try {
      const body = await readFile(join(dir, file));
      c.header("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
      c.header("Cache-Control", isAsset ? "public, max-age=31536000, immutable" : "no-cache");
      return c.body(body);
    } catch {
      return c.notFound();
    }
  });
  return app;
}
