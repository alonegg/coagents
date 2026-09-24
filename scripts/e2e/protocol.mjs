// Agent protocol 2 acceptance with real clients (docs/AGENT_PROTOCOL.md section 7).
//   node scripts/e2e/protocol.mjs setup <workdir>   project, task with checklist, git remote, two bound clones
//   node scripts/e2e/protocol.mjs show              task, submissions with coverage, handoffs
//   node scripts/e2e/protocol.mjs reject "<reason>" | accept
// Needs COAGENTS_HUB, OWNER_USER/OWNER_PASS (reviewer, Codex side), CONTRIB_USER/CONTRIB_PASS
// (Claude Code side) and the `coagents` command on PATH. State goes to $E2E_STATE.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubClient, env, step } from "./client.mjs";

const HUB = env("COAGENTS_HUB");
const STATE = env("E2E_STATE");
const rid = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

async function person(user, pass, label) {
  const c = new HubClient(HUB, label);
  await c.login(env(user), env(pass));
  return c;
}

// Runs the real `coagents login` in dir and approves its code in the person's Hub session.
async function bind(dir, projectId, who, label) {
  const child = spawn("coagents", ["login", "--server", HUB, "--project", projectId, "--label", label], { cwd: dir, stdio: ["ignore", "inherit", "pipe"] });
  let err = "";
  let started = false;
  await new Promise((resolve, reject) => {
    child.stderr.on("data", (d) => {
      err += d;
      const m = /([A-Z]{4}-[A-Z]{4})/.exec(err);
      if (m && !started) {
        started = true;
        who.expect(201, "POST", `/device-codes/${m[1]}/approve`).catch(reject);
      }
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
}

async function setup(work) {
  const owner = await person("OWNER_USER", "OWNER_PASS", "owner");
  const contrib = await person("CONTRIB_USER", "CONTRIB_PASS", "contrib");
  const project = await owner.expect(201, "POST", "/projects", { name: `协议 v2 验收 ${new Date().toISOString().slice(0, 16)}`, description: "slugify 小库：Claude Code 与 Codex 协作" });
  const inv = await owner.expect(201, "POST", `/projects/${project.id}/invitations`, { role: "contributor" });
  await contrib.expect(201, "POST", `/invitations/${inv.token}/accept`);
  const task = await owner.expect(201, "POST", `/projects/${project.id}/tasks`, {
    title: "实现 slugify(text)",
    description: "代码仓库就是当前工作目录。在 feat/slugify 分支上完成，提交并推送到 origin。",
    criteria: [
      { text: "src/slug.js 导出 slugify(text)：英文转小写，空白和标点变成单个 -，去掉首尾的 -" },
      { text: "中文字符原样保留，例如 slugify('你好 World!') === '你好-world'" },
      { text: "test/slug.test.js 覆盖以上规则，npm test 通过" },
      { text: "README.md 写明用法" },
    ],
    request_id: rid(),
  });
  step(`project ${project.id}, task ${task.id} with ${task.criteria.length} criteria`);

  mkdirSync(work, { recursive: true });
  const remote = join(work, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = join(work, "seed");
  execFileSync("git", ["clone", "-q", remote, seed]);
  writeFileSync(join(seed, "package.json"), `${JSON.stringify({ name: "slug", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  writeFileSync(join(seed, "README.md"), "# slug\n");
  writeFileSync(join(seed, ".gitignore"), ".coagents/\n.mcp.json\n");
  git(seed, "add", "."), git(seed, "commit", "-qm", "init"), git(seed, "push", "-q", "origin", "HEAD:main");
  const clones = {};
  for (const [name, who, label] of [["claude", contrib, "Claude Code (e2e)"], ["codex", owner, "Codex CLI (e2e)"]]) {
    const dir = join(work, name);
    execFileSync("git", ["clone", "-q", remote, dir]);
    await bind(dir, project.id, who, label);
    clones[name] = dir;
    step(`${name} clone bound at ${dir}`);
  }
  writeFileSync(STATE, JSON.stringify({ project_id: project.id, task_id: task.id, work, remote, clones }, null, 2), { mode: 0o600 });
}

async function show() {
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  const owner = await person("OWNER_USER", "OWNER_PASS", "owner");
  const t = await owner.expect(200, "GET", `/projects/${s.project_id}/tasks/${s.task_id}`);
  console.log(`task ${t.status} v${t.version} holder=${t.holder ? `${t.holder.display_name}/${t.holder.kind}` : "-"}`);
  for (const sub of t.submissions) {
    console.log(`- submission ${sub.created_at} by ${sub.submitted_by_name} (${sub.author_kind}) outcome=${sub.outcome ?? "pending"}`);
    console.log(`  summary: ${sub.summary}`);
    for (const c of sub.coverage) console.log(`  ${c.criterion_id} ${c.status} (${c.evidence} items)`);
    for (const e of sub.evidence_items) console.log(`    · ${e.criterion_id ?? "-"} ${e.kind} ${e.result ?? ""} ${e.ref ?? ""} ${e.detail ?? ""}`);
    if (sub.evidence) console.log(`  evidence: ${sub.evidence}`);
    if (sub.review_note) console.log(`  review: ${sub.review_note}`);
  }
  const { handoffs } = await owner.expect(200, "GET", `/projects/${s.project_id}/handoffs?task_id=${s.task_id}`);
  for (const h of handoffs) console.log(`- handoff ${h.state} from ${h.from.display_name} (${h.from.author_kind}) steps=${JSON.stringify(h.next_step_items)} git=${h.git ? `${h.git.branch}@${h.git.commit.slice(0, 10)}` : "-"}`);
  const ev = await owner.expect(200, "GET", `/projects/${s.project_id}/events?cursor=0&limit=200`);
  console.log(ev.events.map((e) => `${e.seq} ${e.kind} ${e.actor.display_name}/${e.actor.kind}`).join("\n"));
}

async function review(action, reason) {
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  const owner = await person("OWNER_USER", "OWNER_PASS", "owner");
  const t = await owner.expect(200, "GET", `/projects/${s.project_id}/tasks/${s.task_id}`);
  await owner.expect(200, "POST", `/projects/${s.project_id}/tasks/${s.task_id}/${action}`, {
    expected_version: t.version,
    ...(action === "reject" ? { reason } : {}),
    request_id: rid(),
  });
  step(`${action}ed task ${s.task_id}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "setup") await setup(arg ?? env("E2E_WORK"));
else if (cmd === "show") await show();
else if (cmd === "reject") await review("reject", arg ?? "退回");
else if (cmd === "accept") await review("accept");
else throw new Error("usage: setup <workdir> | show | reject <reason> | accept");
