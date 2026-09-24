import type { AiOutputView, AiSettingsView, BriefingOutput, DigestOutput, PreReviewOutput, ProjectView } from "@coagents/contract";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatTime } from "./api.js";

// Advisory model output. Everything here is rendered as plain text and labelled as unconfirmed.

const OVERALL: Record<PreReviewOutput["overall"], string> = { looks_complete: "证据看起来齐全", has_gaps: "有缺口", insufficient: "证据不足以判断" };
const ASSESSMENT: Record<string, [string, string]> = {
  supported: ["有支撑", "pass"],
  weak: ["证据薄弱", "partial"],
  unsupported: ["无证据", "missing"],
  contradicted: ["与证据矛盾", "fail"],
};

function Status({ out, what }: { out: AiOutputView; what: string }) {
  if (out.status === "pending") return <p className="muted">正在生成{what}…</p>;
  if (out.status === "skipped") return <p className="muted">未生成：{out.error}</p>;
  if (out.status === "failed") return <p className="error">生成失败：{out.error}</p>;
  return null;
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <strong>{title}</strong>
      <ul className="checklist">{items.map((x, i) => <li key={i} className="pre">{x}</li>)}</ul>
    </>
  );
}

function Meta({ out, tz }: { out: AiOutputView; tz: string }) {
  return (
    <small className="muted">
      {out.model ?? ""} · {formatTime(out.updated_at, tz)}
      {!out.current && " · 之后又有变化，可重新生成"}
    </small>
  );
}

// Polls while something is being generated (at most two minutes).
function usePoll<T>(path: string, pending: (d: T) => boolean): [T | null, () => void] {
  const [data, setData] = useState<T | null>(null);
  const load = useCallback(() => {
    api<T>("GET", path).then(setData, () => setData(null));
  }, [path]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!data || !pending(data)) return;
    const started = Date.now();
    const t = setInterval(() => (Date.now() - started > 120_000 ? clearInterval(t) : load()), 3000);
    return () => clearInterval(t);
  }, [data, load, pending]);
  return [data, load];
}

interface TaskAiData {
  available: boolean;
  notice: string;
  prereview: AiOutputView<PreReviewOutput> | null;
  prereview_submission_id: string | null;
  briefing: AiOutputView<BriefingOutput> | null;
}
const taskPending = (d: TaskAiData) => d.prereview?.status === "pending" || d.briefing?.status === "pending";

export function TaskAi({
  projectId,
  taskId,
  tz,
  reviewer,
  writable,
  refresh,
  onUseNote,
}: {
  projectId: string;
  taskId: string;
  tz: string;
  reviewer: boolean;
  writable: boolean;
  refresh: number;
  onUseNote: (note: string) => void;
}) {
  const [d, load] = usePoll<TaskAiData>(`/projects/${projectId}/tasks/${taskId}/ai`, taskPending);
  const [error, setError] = useState<string | null>(null);
  useEffect(load, [refresh, load]);
  if (!d || (!d.available && !d.prereview && !d.briefing)) return null;

  async function start(path: string) {
    setError(null);
    try {
      await api("POST", path);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }
  const pr = d.prereview;
  const br = d.briefing;
  return (
    <section className="ai" aria-label="AI 辅助">
      <h3>AI 辅助 <span className="badge">未经人工确认</span></h3>
      <p className="muted">{d.notice}</p>
      {error && <p className="error">{error}</p>}

      {(pr || (reviewer && d.prereview_submission_id && d.available)) && (
        <div className="ai-block">
          <strong>最近一次提交的预审</strong>
          {pr ? (
            <>
              <Status out={pr} what="预审" />
              {pr.status === "ready" && pr.output && (
                <>
                  <p>结论：<strong>{OVERALL[pr.output.overall]}</strong> <Meta out={pr} tz={tz} /></p>
                  {pr.output.criteria.length > 0 && (
                    <ul className="plain">
                      {pr.output.criteria.map((c) => (
                        <li key={c.criterion_id}>
                          <span className={`cov cov-${ASSESSMENT[c.assessment]?.[1] ?? "unverified"}`}>{ASSESSMENT[c.assessment]?.[0] ?? c.assessment}</span>
                          <span className="muted">{c.criterion_id}</span> <span className="pre">{c.note}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <List title="需要亲自核对" items={pr.output.concerns} />
                  {pr.output.suggested_review_note && (
                    <>
                      <p className="pre quote">{pr.output.suggested_review_note}</p>
                      {reviewer && <button className="link" onClick={() => onUseNote(pr.output!.suggested_review_note)}>填入验收说明</button>}
                    </>
                  )}
                </>
              )}
            </>
          ) : (
            <p className="muted">这次提交还没有预审（提交时 AI 可能未开启）。</p>
          )}
          {reviewer && d.available && pr?.status !== "pending" && (
            <button className="link" onClick={() => start(`/projects/${projectId}/tasks/${taskId}/ai/prereview`)}>{pr ? "重新预审" : "生成预审"}</button>
          )}
        </div>
      )}

      <div className="ai-block">
        <strong>任务简报</strong>
        {br ? (
          <>
            <Status out={br} what="简报" />
            {br.status === "ready" && br.output && (
              <>
                <p className="pre">{br.output.state} <Meta out={br} tz={tz} /></p>
                <List title="已完成" items={br.output.done} />
                <List title="未完成 / 未解决" items={br.output.open_items} />
                <List title="验收意见" items={br.output.review_feedback} />
                <List title="风险" items={br.output.risks} />
                <List title="下一步" items={br.output.next_actions} />
              </>
            )}
          </>
        ) : (
          <p className="muted">汇总任务历次提交、退回意见、交接和相关决策，给接手的人或 Agent 看。</p>
        )}
        {writable && d.available && br?.status !== "pending" && (!br || !br.current || br.status !== "ready") && (
          <button className="link" onClick={() => start(`/projects/${projectId}/tasks/${taskId}/ai/briefing`)}>{br ? "重新生成简报" : "生成简报"}</button>
        )}
      </div>
    </section>
  );
}

interface DigestData {
  available: boolean;
  notice: string;
  digest: AiOutputView<DigestOutput> | null;
}

export function ProjectDigest({ project, tz }: { project: ProjectView; tz: string }) {
  const [hours, setHours] = useState(24);
  const [d, load] = usePoll<DigestData>(`/projects/${project.id}/ai/digest?hours=${hours}`, (x) => x.digest?.status === "pending");
  const [error, setError] = useState<string | null>(null);
  if (!d || (!d.available && !d.digest)) return null;
  const g = d.digest;
  const canStart = project.role !== "viewer" && project.lifecycle === "active" && d.available;
  async function start() {
    setError(null);
    try {
      await api("POST", `/projects/${project.id}/ai/digest`, { hours });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }
  return (
    <section className="panel ai" aria-label="AI 项目动态摘要">
      <div className="row between">
        <h3 className="first">AI 动态摘要 <span className="badge">未经人工确认</span></h3>
        <select aria-label="时间范围" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          <option value={24}>最近 24 小时</option>
          <option value={72}>最近 3 天</option>
          <option value={168}>最近 7 天</option>
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {g && <Status out={g} what="摘要" />}
      {g?.status === "ready" && g.output && (
        <>
          <p><strong>{g.output.headline}</strong> <Meta out={g} tz={tz} /></p>
          <List title="进展" items={g.output.highlights} />
          <List title="需要处理" items={g.output.needs_attention} />
          <List title="决策" items={g.output.decisions} />
          <List title="可能的矛盾" items={g.output.conflicts} />
        </>
      )}
      {!g && <p className="muted">按时间范围总结项目活动：进展、需要人处理的事、决策与矛盾。受限成果不会纳入。</p>}
      {canStart && g?.status !== "pending" && (!g || !g.current || g.status !== "ready") && (
        <button className="link" onClick={start}>{g ? "重新生成" : "生成摘要"}</button>
      )}
    </section>
  );
}

export function ProjectAiSwitch({ project }: { project: ProjectView }) {
  const [d, setD] = useState<{ available: boolean; instance_enabled: boolean; project_enabled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<typeof d>("GET", `/projects/${project.id}/ai`).then(setD, (e: ApiError) => setError(e.message));
  }, [project.id]);
  if (!d) return error ? <p className="error">{error}</p> : null;
  async function toggle() {
    setError(null);
    try {
      setD(await api("PUT", `/projects/${project.id}/ai`, { enabled: !d!.project_enabled }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }
  return (
    <section className="panel">
      <h3 className="first">AI 辅助</h3>
      <p className="muted">
        开启后，提交会自动预审，成员可以生成任务简报和动态摘要。任务、提交、交接、决策和活动的文字会发送给实例配置的模型服务；受限成果和草稿不会发送。AI 只给建议，不会改变任何任务状态。
      </p>
      {!d.instance_enabled && <p className="muted">实例维护者尚未启用 AI 辅助。</p>}
      {error && <p className="error">{error}</p>}
      <p>
        本项目：<strong>{d.project_enabled ? "已开启" : "已关闭"}</strong>{" "}
        {project.lifecycle === "active" && <button className="link" onClick={toggle}>{d.project_enabled ? "关闭" : "开启"}</button>}
      </p>
    </section>
  );
}

interface Usage {
  usage: { project_id: string; project_name: string; kind: string; calls: number; failed: number; prompt_tokens: number; completion_tokens: number; avg_latency_ms: number | null; last_at: string }[];
  recent_errors: { kind: string; error: string; created_at: string }[];
}
const KIND: Record<string, string> = { prereview: "提交预审", briefing: "任务简报", digest: "动态摘要" };

export function AdminAi({ tz }: { tz: string }) {
  const [s, setS] = useState<AiSettingsView | null>(null);
  const [form, setForm] = useState({ base_url: "", model: "", api_key: "", daily_limit: 200 });
  const [usage, setUsage] = useState<Usage | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<AiSettingsView>("GET", "/admin/ai").then((v) => {
      setS(v);
      setForm({ base_url: v.base_url, model: v.model, api_key: "", daily_limit: v.daily_limit });
    }, (e: ApiError) => setError(e.message));
    api<Usage>("GET", "/admin/ai/usage").then(setUsage, () => undefined);
  }, []);
  useEffect(load, [load]);
  if (!s) return error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>;

  async function act(fn: () => Promise<unknown>, done: string) {
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(done);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }
  function save(e: FormEvent) {
    e.preventDefault();
    void act(
      () => api("PUT", "/admin/ai", { base_url: form.base_url, model: form.model, daily_limit: form.daily_limit, ...(form.api_key ? { api_key: form.api_key } : {}) }),
      "已保存。",
    );
  }
  async function test() {
    setError(null);
    setMsg("正在测试…");
    try {
      const r = await api<{ ok: boolean; model?: string; latency_ms?: number; error?: string }>("POST", "/admin/ai/test");
      setMsg(r.ok ? `连接正常：模型 ${r.model}，耗时 ${r.latency_ms} ms。` : null);
      if (!r.ok) setError(`连接失败：${r.error}`);
    } catch (e) {
      setMsg(null);
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }
  return (
    <>
      <p className="muted">
        AI 辅助只给建议：提交预审、任务简报、项目动态摘要。启用后，开启了 AI 的项目会把任务、提交、交接、决策和活动文字发送到下面的模型服务（受限成果与草稿除外）；每次调用都有记录。支持任何 OpenAI 兼容接口，也可以指向本地模型。
      </p>
      <p>
        状态：<strong>{s.enabled ? "已启用" : "未启用"}</strong>{" "}
        <button className="link" disabled={!s.enabled && (!s.base_url || !s.model || !s.api_key_set)} onClick={() => act(() => api("PUT", "/admin/ai", { enabled: !s.enabled }), s.enabled ? "已停用。" : "已启用。")}>
          {s.enabled ? "停用" : "启用"}
        </button>
      </p>
      <form onSubmit={save} className="stack">
        <label>Base URL<input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.openai.com/v1" required /></label>
        <label>模型名称<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} required /></label>
        <label>API Key{s.api_key_set && <small className="muted">（已设置 {s.api_key_hint}；留空则不修改）</small>}
          <input type="password" autoComplete="off" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
        </label>
        <label>每个项目 24 小时调用上限<input type="number" min={0} max={100000} value={form.daily_limit} onChange={(e) => setForm({ ...form, daily_limit: Number(e.target.value) })} /></label>
        <div className="row">
          <button>保存</button>
          <button type="button" className="link" onClick={test} disabled={!s.api_key_set}>测试连接</button>
          {s.api_key_set && <button type="button" className="link danger" onClick={() => act(() => api("PUT", "/admin/ai", { clear_api_key: true, enabled: false }), "已清除 API Key 并停用。")}>清除 API Key</button>}
        </div>
      </form>
      {msg && <p className="notice">{msg}</p>}
      {error && <p className="error">{error}</p>}
      <h3>最近 7 天用量</h3>
      {usage && usage.usage.length === 0 && <p className="muted">暂无调用。</p>}
      {usage && usage.usage.length > 0 && (
        <table>
          <thead><tr><th>项目</th><th>类型</th><th>调用</th><th>失败</th><th>输入 / 输出 tokens</th><th>平均耗时</th><th>最近</th></tr></thead>
          <tbody>
            {usage.usage.map((u) => (
              <tr key={`${u.project_id}-${u.kind}`}>
                <td>{u.project_name}</td><td>{KIND[u.kind] ?? u.kind}</td><td>{u.calls}</td><td>{u.failed}</td>
                <td>{u.prompt_tokens} / {u.completion_tokens}</td><td>{u.avg_latency_ms ?? "—"} ms</td><td>{formatTime(u.last_at, tz)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {usage && usage.recent_errors.length > 0 && (
        <>
          <h3>最近的失败</h3>
          <ul className="plain">{usage.recent_errors.map((e, i) => <li key={i}><span className="muted">{formatTime(e.created_at, tz)} · {KIND[e.kind] ?? e.kind}</span> <code>{e.error}</code></li>)}</ul>
        </>
      )}
    </>
  );
}
