import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SenderGit } from "@coagents/contract";

const run = promisify(execFile);

// Fixed, read-only git queries in the directory the person chose. Arguments are argv arrays, never a
// shell string, and nothing here fetches, checks out, switches branches or writes to the working copy.
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return git(dir, ["rev-parse", "--is-inside-work-tree"]).then((v) => v === "true", () => false);
}

// The CoAgents binding directory is local state, not project work, so it never makes a tree dirty.
async function dirty(dir: string): Promise<boolean> {
  return (await git(dir, ["status", "--porcelain=v1", "--untracked-files=normal", "--", ".", ":(exclude).coagents"])).length > 0;
}

export async function inspectSender(dir: string, remote = "origin"): Promise<SenderGit> {
  const [url, branch, commit, isDirty, remotes] = await Promise.all([
    git(dir, ["remote", "get-url", remote]),
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(dir, ["rev-parse", "HEAD"]),
    dirty(dir),
    git(dir, ["branch", "-r", "--contains", "HEAD"]).catch(() => ""),
  ]);
  return { repo_identity: url, branch, commit, dirty: isDirty, pushed: remotes.length > 0 };
}

export async function inspectReceiver(dir: string, commit: string, remote = "origin"): Promise<{ repo_identity: string; has_commit: boolean; dirty: boolean }> {
  const [url, has, isDirty] = await Promise.all([
    git(dir, ["remote", "get-url", remote]),
    git(dir, ["cat-file", "-e", `${commit}^{commit}`]).then(() => true, () => false),
    dirty(dir),
  ]);
  return { repo_identity: url, has_commit: has, dirty: isDirty };
}
