import type { ProjectView } from "@coagents/contract";
import { useEffect, useState } from "react";
import { api } from "../api.js";

interface Metrics {
  window_days: number;
  reviews: Record<"human" | "agent", { reviewed: number; accepted: number; acceptance_rate: number | null; median_wait_hours: number | null }>;
  first_pass: Record<"human" | "agent", { done: number; first_pass: number; rate: number | null }>;
  waiting_review: { count: number; oldest_hours: number | null };
  blocked: { episodes: number; median_hours: number | null; now: number };
  handoffs: { accepted: number; median_pickup_hours: number | null; pending: number };
  interruptions: { user_id: string; name: string; delivered: number; muted: number }[];
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const h = (x: number | null) => (x === null ? "—" : x < 1 ? `${Math.round(x * 60)} 分钟` : `${x} 小时`);

// Whether collaboration pays off, person vs agent. Numbers only; used by people to judge the boundary.
export function MetricsPanel({ project }: { project: ProjectView }) {
  const [days, setDays] = useState(30);
  const [m, setM] = useState<Metrics | null>(null);
  useEffect(() => {
    api<Metrics>("GET", `/projects/${project.id}/metrics?days=${days}`).then(setM, () => setM(null));
  }, [project.id, days]);
  if (!m) return null;
  return (
    <section className="panel" aria-label="协作指标">
      <div className="row between">
        <h3 className="first">协作指标</h3>
        <select aria-label="统计范围" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>近 7 天</option>
          <option value={30}>近 30 天</option>
          <option value={90}>近 90 天</option>
        </select>
      </div>
      <table>
        <thead><tr><th /><th>人</th><th>Agent</th></tr></thead>
        <tbody>
          <tr><td>验收通过率</td><td>{pct(m.reviews.human.acceptance_rate)}（{m.reviews.human.reviewed} 次）</td><td>{pct(m.reviews.agent.acceptance_rate)}（{m.reviews.agent.reviewed} 次）</td></tr>
          <tr><td>一次通过率</td><td>{pct(m.first_pass.human.rate)}（{m.first_pass.human.done} 个任务）</td><td>{pct(m.first_pass.agent.rate)}（{m.first_pass.agent.done} 个任务）</td></tr>
          <tr><td>提交到验收（中位数）</td><td>{h(m.reviews.human.median_wait_hours)}</td><td>{h(m.reviews.agent.median_wait_hours)}</td></tr>
        </tbody>
      </table>
      <p>
        待验收 {m.waiting_review.count}{m.waiting_review.oldest_hours !== null && `（最久 ${h(m.waiting_review.oldest_hours)}）`} ·
        阻塞 {m.blocked.episodes} 次，中位时长 {h(m.blocked.median_hours)}，当前 {m.blocked.now} 个 ·
        交接接手 {m.handoffs.accepted} 次，中位用时 {h(m.handoffs.median_pickup_hours)}，待接手 {m.handoffs.pending}
      </p>
      {m.interruptions.length > 0 && (
        <p className="muted">
          Agent 打扰：{m.interruptions.map((i) => `${i.name} ${i.delivered} 次${i.muted ? `（另有 ${i.muted} 次超出上限未提醒）` : ""}`).join("；")}
        </p>
      )}
      <small className="muted">只统计数量，用来判断协作是否真的省力；不会据此自动调整任何权限。</small>
    </section>
  );
}
