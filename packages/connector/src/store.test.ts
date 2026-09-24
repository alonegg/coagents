import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { deleteCredential, loadCredential, otherConnections, saveCredential, type Credential } from "./store.js";

const cred = (client_id: string, workdir?: string): Credential => ({
  server: "https://hub.example",
  project_id: "prj_1",
  client_id,
  device_id: "dev_1",
  scopes: ["read", "write"],
  agent_token: `tok-${client_id}`,
  created_at: "",
  ...(workdir ? { workdir } : {}),
});

it("keeps one agent connection per working copy, falling back to a 0.1 per-project credential", () => {
  const home = mkdtempSync(join(tmpdir(), "coagents-home-"));
  const a = mkdtempSync(join(tmpdir(), "wc-a-"));
  const b = mkdtempSync(join(tmpdir(), "wc-b-"));
  saveCredential(home, cred("cli_legacy"));
  saveCredential(home, cred("cli_a", a));
  saveCredential(home, cred("cli_b", b));
  expect(loadCredential(home, "https://hub.example/", "prj_1", a)?.client_id).toBe("cli_a");
  expect(loadCredential(home, "https://hub.example", "prj_1", b)?.client_id).toBe("cli_b");
  expect(loadCredential(home, "https://hub.example", "prj_1", join(tmpdir(), "elsewhere"))?.client_id).toBe("cli_legacy");
  expect(otherConnections(home, "https://hub.example", "prj_1", a).map((c) => c.client_id).sort()).toEqual(["cli_b", "cli_legacy"]);
  deleteCredential(home, cred("cli_a", a));
  expect(loadCredential(home, "https://hub.example", "prj_1", a)?.client_id).toBe("cli_legacy");
  expect(loadCredential(home, "https://hub.example", "prj_1", b)?.client_id).toBe("cli_b");
});
