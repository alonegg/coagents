// M1 acceptance: two independent machines reach the same project over public HTTPS.
//   prepare (machine A, owner): create project + two targeted invitations, print them as JSON
//   join    (machine B):        register both accounts from invitations, accept, verify isolation and denials
//   verify  (machine A):        owner sees both members who joined from machine B
import assert from "node:assert/strict";
import tls from "node:tls";
import { HubClient, env, step } from "./client.mjs";

const HUB = env("COAGENTS_HUB");
const [, , phase] = process.argv;

async function prepare() {
  const owner = new HubClient(HUB, "owner-A");
  await owner.login(env("E2E_OWNER_USER"), env("E2E_OWNER_PASSWORD"));
  const project = await owner.expect(201, "POST", "/projects", { name: `M1 验收 ${new Date().toISOString()}`, description: "跨机登录验收" });
  const contributor = await owner.expect(201, "POST", `/projects/${project.id}/invitations`, {
    role: "contributor",
    target_username: env("E2E_CONTRIB_USER"),
    expires_in_hours: 2,
  });
  const viewer = await owner.expect(201, "POST", `/projects/${project.id}/invitations`, {
    role: "viewer",
    target_username: env("E2E_VIEWER_USER"),
    expires_in_hours: 2,
  });
  // A second, private project the other machine must never see.
  const secret = await owner.expect(201, "POST", "/projects", { name: "M1 私有对照项目", description: "" });
  console.log(JSON.stringify({ project_id: project.id, secret_project_id: secret.id, contributor_token: contributor.token, viewer_token: viewer.token }));
}

async function joinAs(user, password, token, role, projectId, secretId) {
  const b = new HubClient(HUB, `${role}-B`);
  const preview = await b.expect(200, "GET", `/invitations/${token}`);
  assert.equal(preview.role, role);
  b.adopt(
    await b.expect(201, "POST", `/invitations/${token}/register`, {
      username: user,
      display_name: `E2E ${role}`,
      password,
      timezone: "America/Los_Angeles",
    }),
  );
  await b.expect(404, "GET", `/projects/${projectId}`);
  step(`${role}: registered from invitation, no access before accepting`);
  await b.expect(201, "POST", `/invitations/${token}/accept`);
  const p = await b.expect(200, "GET", `/projects/${projectId}`);
  assert.equal(p.role, role);
  step(`${role}: accepted and sees project ${projectId} as ${role}`);
  const list = await b.expect(200, "GET", "/projects");
  assert.deepEqual(list.projects.map((x) => x.id), [projectId]);
  const hidden = await b.call("GET", `/projects/${secretId}`);
  const missing = await b.call("GET", "/projects/prj_does_not_exist");
  assert.deepEqual(hidden, missing);
  assert.equal(hidden.status, 404);
  step(`${role}: private project is indistinguishable from a missing one`);
  await b.expect(404, "POST", `/invitations/${token}/accept`);
  step(`${role}: used invitation cannot be reused`);
  return b;
}

async function join() {
  const { project_id, secret_project_id, contributor_token, viewer_token } = JSON.parse(env("E2E_INVITES"));
  const anon = new HubClient(HUB, "anon-B");
  await anon.expect(401, "GET", "/projects");
  await anon.expect(404, "POST", "/invitations/not-a-real-token/register", {
    username: "intruder",
    display_name: "x",
    password: "0123456789ab",
    timezone: "UTC",
  });
  step("anonymous: no project access, registration without a valid invitation rejected");

  const contributor = await joinAs(env("E2E_CONTRIB_USER"), env("E2E_CONTRIB_PASSWORD"), contributor_token, "contributor", project_id, secret_project_id);
  const viewer = await joinAs(env("E2E_VIEWER_USER"), env("E2E_VIEWER_PASSWORD"), viewer_token, "viewer", project_id, secret_project_id);
  for (const b of [contributor, viewer]) {
    await b.expect(403, "POST", `/projects/${project_id}/invitations`, { role: "viewer" });
  }
  step("contributor and viewer cannot create invitations");

  const noCsrf = new HubClient(HUB, "csrf-B");
  await noCsrf.login(env("E2E_CONTRIB_USER"), env("E2E_CONTRIB_PASSWORD"));
  noCsrf.csrf = "";
  await noCsrf.expect(403, "POST", "/projects", { name: "csrf" });
  step("write without CSRF token rejected");

  await assertCertificateRejected();
}

// The server must not answer an unknown server name with some fallback certificate.
function assertCertificateRejected() {
  const host = new URL(HUB).hostname;
  return new Promise((resolve, reject) => {
    import("node:dns").then(({ promises }) => promises.lookup(host)).then(({ address }) => {
      const socket = tls.connect({ host: address, port: 443, servername: "wrong-name.invalid" }, () => {
        socket.destroy();
        reject(new Error("TLS connection with a wrong server name was accepted"));
      });
      socket.on("error", (err) => {
        step(`server refuses TLS for an unknown server name, no fallback certificate (${err.code})`);
        resolve();
      });
    }, reject);
  });
}

async function verify() {
  const { project_id } = JSON.parse(env("E2E_INVITES"));
  const owner = new HubClient(HUB, "owner-A");
  await owner.login(env("E2E_OWNER_USER"), env("E2E_OWNER_PASSWORD"));
  const { members } = await owner.expect(200, "GET", `/projects/${project_id}/members`);
  const roles = Object.fromEntries(members.map((m) => [m.username, m.role]));
  assert.equal(roles[env("E2E_CONTRIB_USER")], "contributor");
  assert.equal(roles[env("E2E_VIEWER_USER")], "viewer");
  step(`owner on machine A sees members who joined from machine B: ${JSON.stringify(roles)}`);
  const { records } = await owner.expect(200, "GET", `/projects/${project_id}/audit`);
  assert.equal(records.filter((r) => r.action === "invitation.accept").length, 2);
  step("audit records both acceptances");
}

const phases = { prepare, join, verify };
if (!phases[phase]) {
  console.error("usage: node scripts/e2e/m1.mjs prepare|join|verify");
  process.exit(2);
}
await phases[phase]();
