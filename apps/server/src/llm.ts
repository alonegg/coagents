import { z } from "zod";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmResult<T> {
  value: T;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
}

export class LlmError extends Error {}

const TIMEOUT_MS = 120_000;

// JSON Schema for response_format, without keywords strict structured-output modes reject.
function responseSchema(schema: z.ZodType): unknown {
  const drop = new Set(["$schema", "maxLength", "minLength", "maxItems", "minItems", "pattern", "format"]);
  const clean = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(clean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !drop.has(k)).map(([k, x]) => [k, clean(x)])) : v;
  return clean(z.toJSONSchema(schema));
}

// One chat completion against an OpenAI-compatible endpoint, answered as JSON that must match
// `schema`. Model output is untrusted: it is parsed and validated, never executed.
export async function chatJson<T>(cfg: LlmConfig, name: string, system: string, user: string, schema: z.ZodType<T>): Promise<LlmResult<T>> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_schema", json_schema: { name, strict: true, schema: responseSchema(schema) } },
        temperature: 0.2,
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new LlmError(`model endpoint unreachable: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: { choices?: { message?: { content?: string } }[]; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { code?: string; message?: string } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new LlmError(`model endpoint returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok || body.error) throw new LlmError(`model endpoint error (HTTP ${res.status}): ${body.error?.code ?? ""} ${(body.error?.message ?? "").slice(0, 300)}`.trim());
  const content = body.choices?.[0]?.message?.content ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    throw new LlmError("model answer is not JSON");
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) throw new LlmError(`model answer does not match the schema: ${checked.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return {
    value: checked.data,
    model: body.model ?? cfg.model,
    promptTokens: body.usage?.prompt_tokens ?? null,
    completionTokens: body.usage?.completion_tokens ?? null,
    latencyMs: Date.now() - started,
  };
}
