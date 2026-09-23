import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROJECT_BINDING_DIR, PROJECT_BINDING_FILE, ProjectBinding } from "@coagents/contract";

export type BindingResult =
  | { ok: true; binding: ProjectBinding; path: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid"; path: string; message: string };

// Walk up from startDir to the filesystem root looking for .coagents/project.json.
// The nearest file wins; an invalid nearest file is an error, never a fallback to a parent project.
export function findProjectBinding(startDir: string): BindingResult {
  let dir = startDir;
  for (;;) {
    const path = join(dir, PROJECT_BINDING_DIR, PROJECT_BINDING_FILE);
    let raw: string | undefined;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (raw !== undefined) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return { ok: false, reason: "invalid", path, message: "not valid JSON" };
      }
      const parsed = ProjectBinding.safeParse(json);
      return parsed.success
        ? { ok: true, binding: parsed.data, path }
        : { ok: false, reason: "invalid", path, message: parsed.error.message };
    }
    const parent = dirname(dir);
    if (parent === dir) return { ok: false, reason: "not_found" };
    dir = parent;
  }
}
