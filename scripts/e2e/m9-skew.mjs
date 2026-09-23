// Clock-skew injection: run under libfaketime (e.g. `faketime -f '+3h' node ...`). The client clock is
// wrong; leases, expiry and overdue flags must follow the server clock only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HubClient, env, step } from "./client.mjs";

const HUB = env("COAGENTS_HUB");
const { project_id: pid } = JSON.parse(env("E2E_PAYLOAD"));
const rid = () => `skew-${randomUUID()}`;

const probe = await fetch(`${HUB}/v1/health`);
const serverNow = Date.parse(probe.headers.get("date"));
const skewMin = Math.round((Date.now() - serverNow) / 60_000);
assert.ok(Math.abs(skewMin) >= 60, `expected a skewed client clock, got ${skewMin} min`);
step(`client clock is ${skewMin > 0 ? "+" : ""}${skewMin} min off the server's`);

const c = new HubClient(HUB, "skewed");
await c.login(env("E2E_CONTRIB_USER"), env("E2E_CONTRIB_PASSWORD"));
const t = await c.expect(201, "POST", `/projects/${pid}/tasks`, { title: `时钟偏差 ${new Date(serverNow).toISOString()}`, request_id: rid() });
const claim = await c.expect(200, "POST", `/projects/${pid}/tasks/${t.id}/claim`, { request_id: rid() });
const leaseMin = (Date.parse(claim.lease_until) - serverNow) / 60_000;
assert.ok(leaseMin > 29 && leaseMin < 31.5, `lease ${leaseMin} min from server now`);
assert.equal(claim.task.holder.lease_active, true);
step(`lease runs ${leaseMin.toFixed(1)} min from the server's now, and is active per the server`);

await c.expect(200, "POST", `/projects/${pid}/tasks/${t.id}/renew`, { request_id: rid() });
// A plain due date "today" in server time is not overdue, whatever the client believes.
const today = new Date(serverNow).toISOString().slice(0, 10);
const due = await c.expect(200, "PUT", `/projects/${pid}/tasks/${t.id}/due`, { expected_version: (await c.expect(200, "GET", `/projects/${pid}/tasks/${t.id}`)).version, due_at: today, request_id: rid() });
assert.equal(due.overdue, Date.parse(due.due_at) < serverNow);
const sub = await c.expect(200, "POST", `/projects/${pid}/tasks/${t.id}/submit`, { summary: "时钟偏差下提交", evidence: "租约与逾期均按服务端时钟", request_id: rid() });
assert.equal(sub.task.status, "review");
step(`renew, due date and submit all behave by server time (overdue=${due.overdue}); session and cookies unaffected`);
