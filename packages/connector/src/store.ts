import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
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
  // The working copy this agent connection belongs to. Each working copy logs in as its own
  // connection, so two agents on one machine never share an identity or leases. Absent on
  // credentials written by Connector 0.1, which were per project.
  workdir?: string;
}

function credentialsPath(home: string): string {
  return join(home, "credentials.json");
}

export function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export function credentialKey(server: string, projectId: string, workdir?: string): string {
  return `${new URL(server).origin}|${projectId}${workdir ? `|${canonicalDir(workdir)}` : ""}`;
}

// The working copy's own connection first, then a per-project credential from Connector 0.1.
export function loadCredential(home: string, server: string, projectId: string, workdir?: string): Credential | undefined {
  const all = readJson<Record<string, Credential>>(credentialsPath(home), {});
  return (workdir ? all[credentialKey(server, projectId, workdir)] : undefined) ?? all[credentialKey(server, projectId)];
}

export function saveCredential(home: string, cred: Credential): void {
  const all = readJson<Record<string, Credential>>(credentialsPath(home), {});
  all[credentialKey(cred.server, cred.project_id, cred.workdir)] = cred;
  writeFileAtomic(credentialsPath(home), `${JSON.stringify(all, null, 2)}\n`);
}

export function deleteCredential(home: string, cred: Credential): void {
  const all = readJson<Record<string, Credential>>(credentialsPath(home), {});
  delete all[credentialKey(cred.server, cred.project_id, cred.workdir)];
  writeFileAtomic(credentialsPath(home), `${JSON.stringify(all, null, 2)}\n`);
}

// Other working copies on this machine already connected to the project, for the login notice.
export function otherConnections(home: string, server: string, projectId: string, workdir: string): Credential[] {
  const own = credentialKey(server, projectId, workdir);
  return Object.entries(readJson<Record<string, Credential>>(credentialsPath(home), {}))
    .filter(([k, c]) => k !== own && c.project_id === projectId && new URL(c.server).origin === new URL(server).origin)
    .map(([, c]) => c);
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

export function forgetClientLeases(home: string, clientId: string): void {
  const all = readJson<Record<string, string>>(leasesPath(home), {});
  const kept = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith(`${clientId}|`)));
  if (Object.keys(kept).length !== Object.keys(all).length) writeFileAtomic(leasesPath(home), `${JSON.stringify(kept, null, 2)}\n`);
}

export function forgetLease(home: string, clientId: string, taskId: string): void {
  const all = readJson<Record<string, string>>(leasesPath(home), {});
  if (delete all[`${clientId}|${taskId}`]) writeFileAtomic(leasesPath(home), `${JSON.stringify(all, null, 2)}\n`);
}

// After an uninstall: remove local state files that no longer hold anything, and the home directory
// itself when it is empty, so a clean machine is left clean.
export function pruneHome(home: string): void {
  for (const name of ["credentials.json", "leases.json", "installs.json"]) {
    const path = join(home, name);
    const data = readJson<Record<string, unknown> | null>(path, null);
    if (data !== null && Object.keys(data).length === 0) rmSync(path, { force: true });
  }
  try {
    if (readdirSync(home).length === 0) rmdirSync(home);
  } catch {
    // missing or not empty: leave it
  }
}
