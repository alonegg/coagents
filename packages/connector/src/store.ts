import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Local state lives in ~/.coagents (override with COAGENTS_HOME). Files holding secrets are 0600.
export function coagentsHome(): string {
  return process.env.COAGENTS_HOME ?? join(homedir(), ".coagents");
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

// Write to a temp file in the same directory, then rename: readers never see a partial file.
export function writeFileAtomic(path: string, content: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export interface Credential {
  server: string;
  project_id: string;
  client_id: string;
  device_id: string;
  scopes: string[];
  agent_token: string;
  created_at: string;
}

function credentialsPath(home: string): string {
  return join(home, "credentials.json");
}

export function credentialKey(server: string, projectId: string): string {
  return `${new URL(server).origin}|${projectId}`;
}

export function loadCredential(home: string, server: string, projectId: string): Credential | undefined {
  return readJson<Record<string, Credential>>(credentialsPath(home), {})[credentialKey(server, projectId)];
}

export function saveCredential(home: string, cred: Credential): void {
  const all = readJson<Record<string, Credential>>(credentialsPath(home), {});
  all[credentialKey(cred.server, cred.project_id)] = cred;
  writeFileAtomic(credentialsPath(home), `${JSON.stringify(all, null, 2)}\n`);
}

export function deleteCredential(home: string, server: string, projectId: string): void {
  const all = readJson<Record<string, Credential>>(credentialsPath(home), {});
  delete all[credentialKey(server, projectId)];
  writeFileAtomic(credentialsPath(home), `${JSON.stringify(all, null, 2)}\n`);
}

// Lease tokens from claims, so an agent does not have to carry them between tool calls.
function leasesPath(home: string): string {
  return join(home, "leases.json");
}

export function rememberLease(home: string, clientId: string, taskId: string, token: string): void {
  const all = readJson<Record<string, string>>(leasesPath(home), {});
  all[`${clientId}|${taskId}`] = token;
  writeFileAtomic(leasesPath(home), `${JSON.stringify(all, null, 2)}\n`);
}

export function recallLease(home: string, clientId: string, taskId: string): string | undefined {
  return readJson<Record<string, string>>(leasesPath(home), {})[`${clientId}|${taskId}`];
}

export function forgetLease(home: string, clientId: string, taskId: string): void {
  const all = readJson<Record<string, string>>(leasesPath(home), {});
  if (delete all[`${clientId}|${taskId}`]) writeFileAtomic(leasesPath(home), `${JSON.stringify(all, null, 2)}\n`);
}
