import type { Context } from "hono";
import type * as z from "zod";
import { invalid } from "./http-error.js";

export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw invalid("Request body must be JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return parsed.data;
}
