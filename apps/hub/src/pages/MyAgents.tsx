import type { SessionView } from "@coagents/contract";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, formatTime } from "../api.js";

interface MyAgent {
  id: string;
  label: string;
  project_id: string;
  project_name: string;
  project_paused_at: string | null;
  device_label: string;
  scopes: string[];
  created_at: string;
  last_seen_at: string | null;
  paused_at: string | null;
  holding: { id: string; title: string; lease_until: string }[];
  submissions: Record<string, number>;
  recent: { kind: string; summary: string; subject_type: string; subject_id: string; created_at: string }[];
  interrupts_last_24h: number;
}

// Everything that acts in my name: each agent connection, what it holds, what it did, how its
// work fared in review, and how often it interrupted people. Pause or revoke from here.
export function MyAgentsPage({ session }: { session: SessionView }) {
  const [agents, setAgents] = useState<MyAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ agents: MyAgent[] }>("GET", "/me/agents").then((r) => setAgents(r.agents), (e: ApiError) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const tz = session.user.timezone;

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <>
      <h1>我的 Agent</h1>
      <p className="muted">这些 Agent 连接以你的身份行事，权限不超过你在项目中的角色。暂停后只能读取、不能写入；撤销后连接失效，持有的任务租约立即结束。</p>
      {error && <p className="error">{error}</p>}
      {agents?.length === 0 && <p className="muted">你还没有 Agent 连接。在项目的“Agent 连接”页可以找到接入命令。</p>}
      {agents?.map((a) => {
        const reviewed = (a.submissions.accepted ?? 0) + (a.submissions.rejected ?? 0);
        return (
          <section key={a.id} className="panel">
            <div className="row between">
              <h3 className="first">
                {a.label} <span className="muted">· <a href={`#/projects/${a.project_id}/agents`}>{a.project_name}</a> · {a.device_label}</span>
              </h3>
              <div className="row">
                <button className="link" onClick={() => act(() => api("PUT", `/projects/${a.project_id}/agents/${a.id}/pause`, { paused: !a.paused_at }))}>
                  {a.paused_at ? "恢复" : "暂停"}
                </button>
                <button className="link danger" onClick={() => act(() => api("DELETE", `/projects/${a.project_id}/agents/${a.id}`))}>撤销</button>
              </div>
            </div>
            <p>
              {a.paused_at ? <strong className="warn">已暂停（{formatTime(a.paused_at, tz)}）</strong> : a.project_paused_at ? <strong className="warn">项目已暂停所有 Agent</strong> : "运行中"}
              {" · "}{a.scopes.includes("write") ? "读写" : "只读"} · 最近活动 {a.last_seen_at ? formatTime(a.last_seen_at, tz) : "—"}
            </p>
            <p>
              持有任务：{a.holding.length === 0 ? "无" : a.holding.map((t) => <a key={t.id} href={`#/projects/${a.project_id}/tasks/${t.id}`}>{t.title}（租约至 {formatTime(t.lease_until, tz)}） </a>)}
            </p>
            <p>
              提交：待验收 {a.submissions.pending ?? 0} · 已接受 {a.submissions.accepted ?? 0} · 已退回 {a.submissions.rejected ?? 0}
              {reviewed > 0 && <span className="muted">（通过率 {Math.round(((a.submissions.accepted ?? 0) / reviewed) * 100)}%）</span>}
              {" · "}24 小时内打扰他人 {a.interrupts_last_24h} 次
            </p>
            {a.recent.length > 0 && (
              <ul className="plain">
                {a.recent.map((e, i) => (
                  <li key={i} className="muted">
                    {formatTime(e.created_at, tz)} · {e.summary}
                    {e.subject_type === "task" && <> · <a href={`#/projects/${a.project_id}/tasks/${e.subject_id}`}>查看</a></>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}
