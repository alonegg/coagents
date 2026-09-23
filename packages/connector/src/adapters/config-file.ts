import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeFileAtomic } from "../store.js";

// A client whose MCP configuration lives in one file we can edit as a whole.
export interface ConfigFormat {
  client: string;
  // Returns the new file content with our entry added, or null if the entry is already present and identical.
  add(before: string | null, entry: McpEntry): string | null;
  // Returns the content with our entry removed, or null when our entry is absent.
  remove(current: string, entry: McpEntry): string | null;
}

export interface McpEntry {
  name: string;
  command: string;
  args: string[];
}

interface InstallRecord {
  client: string;
  before_b64: string | null;
  after_sha256: string;
  installed_at: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function recordsPath(home: string): string {
  return join(home, "installs.json");
}

export interface Plan {
  path: string;
  before: string | null;
  after: string | null;
}

export function planInstall(format: ConfigFormat, path: string, entry: McpEntry): Plan {
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  return { path, before, after: format.add(before, entry) };
}

// Writes only when there is a change; keeps the original bytes so an untouched file can be restored exactly.
export function applyInstall(format: ConfigFormat, plan: Plan, home: string): boolean {
  if (plan.after === null) return false;
  if (plan.before !== null) writeFileAtomic(`${plan.path}.coagents-backup`, plan.before, 0o600);
  writeFileAtomic(plan.path, plan.after, 0o644);
  const records = readJson<Record<string, InstallRecord>>(recordsPath(home), {});
  const prior = records[plan.path];
  records[plan.path] = {
    client: format.client,
    // Re-installing over our own earlier install keeps the original pre-install bytes.
    before_b64: prior ? prior.before_b64 : plan.before === null ? null : Buffer.from(plan.before).toString("base64"),
    after_sha256: sha(plan.after),
    installed_at: new Date().toISOString(),
  };
  writeFileAtomic(recordsPath(home), `${JSON.stringify(records, null, 2)}\n`);
  return true;
}

export type RemoveOutcome = "restored" | "entry_removed" | "not_installed";

// If the file is exactly what we wrote, restore the original bytes (or delete a file we created).
// If the person edited it since, remove only our entry and leave their changes.
export function removeInstall(format: ConfigFormat, path: string, entry: McpEntry, home: string): RemoveOutcome {
  const records = readJson<Record<string, InstallRecord>>(recordsPath(home), {});
  const rec = records[path];
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  let outcome: RemoveOutcome = "not_installed";
  if (current !== null && rec && sha(current) === rec.after_sha256) {
    if (rec.before_b64 === null) unlinkSync(path);
    else writeFileAtomic(path, Buffer.from(rec.before_b64, "base64"), 0o644);
    outcome = "restored";
  } else if (current !== null) {
    const next = format.remove(current, entry);
    if (next !== null) {
      writeFileAtomic(path, next, 0o644);
      outcome = "entry_removed";
    }
  }
  if (rec) {
    delete records[path];
    writeFileAtomic(recordsPath(home), `${JSON.stringify(records, null, 2)}\n`);
  }
  if (existsSync(`${path}.coagents-backup`)) unlinkSync(`${path}.coagents-backup`);
  return outcome;
}

// Line diff for previews; configuration files are small.
export function diffLines(before: string | null, after: string | null): string {
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (j < b.length && !a.slice(i).includes(b[j]!)) {
      out.push(`+ ${b[j]}`);
      j++;
    } else {
      out.push(`- ${a[i]}`);
      i++;
    }
  }
  return out.join("\n");
}
