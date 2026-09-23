// M2 acceptance: concurrent claims from two independent machines never produce two holders,
// and retried writes after a lost response never duplicate.
//   prepare (A): project + N tasks + targeted invitation for B; prints payload with a shared start time
//   race    (A and B): accept invitation if needed, wait for start time, claim every task concurrently,
//                      print the ids this machine won as a line "WON <json>"
//   verify  (A): server state must show exactly one holder per task, matching the winners from both machines
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HubClient, env, step } from "./client.mjs";

const HUB = env("COAGENTS_HUB");
const N = Number(process.env.E2E_TASKS ?? 100);
const [, , phase, machine] = process.argv;

async function asOwner() {
  const c = new HubClient(HUB, "owner-A");
  await c.login(env("E2E_OWNER_USER"), env("E2E_OWNER_PASSWORD"));
  return c;
}

async function prepare() {
  const owner = await asOwner();
  const project = await owner.expect(201, "POST", "/projects", { name: `M2 并发认领 ${new Date().toISOString()}`, description: "" });
  const ids = [];
  for (let i = 0; i < N; i++) {
    const t = await owner.expect(201, "POST", `/projects/${project.id}/tasks`, { title: `并发任务 ${i + 1}`, request_id: `m2-${project.id}-${i}` });
    ids.push(t.id);
  }
  const invite = await owner.expect(201, "POST", `/projects/${project.id}/invitations`, {
    role: "contributor",
    target_username: env("E2E_CONTRIB_USER"),
    expires_in_hours: 2,
  });
  const startAt = Date.now() + Number(process.env.E2E_START_DELAY_MS ?? 150_000);
  console.log(JSON.stringify({ project_id: project.id, task_ids: ids, invite_token: invite.token, start_at: startAt }));
}

async function race() {
  const payload = JSON.parse(env("E2E_PAYLOAD"));
  let client;
  if (machine === "A") {
    client = await asOwner();
  } else {
    client = new HubClient(HUB, "contrib-B");
    await client.login(env("E2E_CONTRIB_USER"), env("E2E_CONTRIB_PASSWORD"));
    const accepted = await client.call("POST", `/invitations/${payload.invite_token}/accept`);
    assert.ok([201, 404].includes(accepted.status), JSON.stringify(accepted.body));
    await client.expect(200, "GET", `/projects/${payload.project_id}`);
  }
  const wait = payload.start_at - Date.now();
  assert.ok(wait > 0, `start time already passed by ${-wait}ms; prepare again with a longer delay`);
  step(`${machine}: ready, starting in ${wait}ms`);
  await new Promise((r) => setTimeout(r, wait));

  const results = await Promise.all(
    payload.task_ids.map((id) => client.call("POST", `/projects/${payload.project_id}/tasks/${id}/claim`, { request_id: `race-${machine}-${randomUUID()}` })),
  );
  const won = payload.task_ids.filter((_, i) => results[i].status === 200);
  const codes = {};
  for (const r of results) codes[r.status === 200 ? "won" : r.body?.error?.code ?? r.status] = (codes[r.status === 200 ? "won" : r.body?.error?.code ?? r.status] ?? 0) + 1;
  step(`${machine}: ${JSON.stringify(codes)}`);
  const unexpected = results.filter((r) => r.status !== 200 && r.body?.error?.code !== "task_already_held");
  assert.equal(unexpected.length, 0, `unexpected responses: ${JSON.stringify(unexpected.slice(0, 3))}`);
  console.log(`WON ${JSON.stringify(won)}`);
}

async function verify() {
  const payload = JSON.parse(env("E2E_PAYLOAD"));
  const wonA = new Set(JSON.parse(env("E2E_WON_A")));
  const wonB = new Set(JSON.parse(env("E2E_WON_B")));
  const both = [...wonA].filter((id) => wonB.has(id));
  assert.equal(both.length, 0, `tasks claimed successfully by both machines: ${both.join(",")}`);
  assert.equal(wonA.size + wonB.size, payload.task_ids.length, "every task should have exactly one successful claim");
  step(`claims: machine A won ${wonA.size}, machine B won ${wonB.size}, both-won 0`);

  const owner = await asOwner();
  const { tasks } = await owner.expect(200, "GET", `/projects/${payload.project_id}/tasks`);
  const owners = { [env("E2E_OWNER_USER")]: wonA, [env("E2E_CONTRIB_USER")]: wonB };
  const { members } = await owner.expect(200, "GET", `/projects/${payload.project_id}/members`);
  const nameOf = Object.fromEntries(members.map((m) => [m.user_id, m.username]));
  for (const t of tasks) {
    assert.equal(t.status, "in_progress");
    assert.ok(t.holder?.lease_active, `${t.id} has no active holder`);
    assert.ok(owners[nameOf[t.holder.user_id]].has(t.id), `${t.id} holder does not match the machine that won it`);
  }
  step(`server state: ${tasks.length} tasks, each with exactly the holder that won its claim`);

  const events = [];
  for (let cursor = 0; ; ) {
    const page = await owner.expect(200, "GET", `/projects/${payload.project_id}/events?cursor=${cursor}&limit=200`);
    events.push(...page.events);
    cursor = page.next_cursor;
    if (!page.has_more) break;
  }
  assert.equal(events.filter((e) => e.kind === "task.claimed").length, payload.task_ids.length);
  step("exactly one task.claimed event per task");

  // Lost response: abort the first attempt early, then retry with the same request_id.
  const title = `幂等 ${randomUUID()}`;
  const rid = `lost-${randomUUID()}`;
  const aborted = await fetch(`${HUB}/v1/projects/${payload.project_id}/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": owner.csrf,
      cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: JSON.stringify({ title, request_id: rid }),
    signal: AbortSignal.timeout(5),
  }).then(() => "completed", (e) => e.name);
  await new Promise((r) => setTimeout(r, 1500));
  await owner.call("POST", `/projects/${payload.project_id}/tasks`, { title, request_id: rid });
  await owner.call("POST", `/projects/${payload.project_id}/tasks`, { title, request_id: rid });
  const after = (await owner.expect(200, "GET", `/projects/${payload.project_id}/tasks`)).tasks.filter((t) => t.title === title);
  assert.equal(after.length, 1);
  step(`first attempt ${aborted}; after two retries with the same request_id exactly 1 task exists`);
}

const phases = { prepare, race, verify };
if (!phases[phase]) {
  console.error("usage: node scripts/e2e/m2.mjs prepare | race A|B | verify");
  process.exit(2);
}
await phases[phase]();
