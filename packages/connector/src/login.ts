import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_BINDING_DIR, PROJECT_BINDING_FILE, type DeviceCodeGrant, type DeviceTokenResult } from "@coagents/contract";
import { ServiceClient, ServiceError } from "./service.js";
import { canonicalDir, otherConnections, readJson, saveCredential, writeFileAtomic } from "./store.js";

export interface LoginOptions {
  server: string;
  projectId: string;
  label: string;
  scopes: ("read" | "write")[];
  dir: string;
  home: string;
  // Where to tell the person what to do; stderr in the CLI.
  say: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

// Device-code login: the person approves this device and project in the Hub; the Connector never
// sees their password or browser session.
export async function login(o: LoginOptions): Promise<{ client_id: string }> {
  const server = new URL(o.server).origin;
  const svc = new ServiceClient(server);
  const grant = await svc.call<DeviceCodeGrant>("POST", "/device-codes", {
    project_id: o.projectId,
    client_label: o.label,
    scopes: o.scopes,
  });
  o.say(`在已登录的 CoAgents Hub 中打开下面的地址，核对设备与项目后批准：`);
  o.say(`  ${grant.verification_url}`);
  o.say(`  确认码：${grant.user_code}（${Math.round(grant.expires_in / 60)} 分钟内有效）`);
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + grant.expires_in * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new ServiceError(0, "expired_token", "确认码已过期，请重新登录");
    await sleep(grant.interval * 1000);
    const res = await svc.call<DeviceTokenResult>("POST", "/device-codes/token", { device_code: grant.device_code });
    if (res.status === "approved") {
      saveCredential(o.home, {
        server,
        project_id: res.project_id,
        client_id: res.client_id,
        device_id: res.device_id,
        scopes: res.scopes,
        agent_token: res.agent_token,
        created_at: new Date().toISOString(),
        workdir: canonicalDir(o.dir),
      });
      bindProject(o.dir, server, res.project_id);
      o.say(`已授权：Agent 连接 ${res.client_id}，项目 ${res.project_id}，工作目录 ${canonicalDir(o.dir)}。`);
      const others = otherConnections(o.home, server, res.project_id, o.dir).filter((c) => c.workdir);
      if (others.length) o.say(`本机另有 ${others.length} 个工作目录连接到此项目，它们各自是独立的 Agent 连接。`);
      return { client_id: res.client_id };
    }
  }
}

// .coagents/project.json names the server and project for this working tree. It holds no secrets.
export function bindProject(dir: string, server: string, projectId: string): void {
  const path = join(dir, PROJECT_BINDING_DIR, PROJECT_BINDING_FILE);
  const current = existsSync(path) ? readJson<{ server?: string; project_id?: string }>(path, {}) : {};
  if (current.server === server && current.project_id === projectId) return;
  writeFileAtomic(path, `${JSON.stringify({ server, project_id: projectId }, null, 2)}\n`, 0o644);
}
