import type { SessionView } from "@coagents/contract";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatTime } from "../api.js";
import { go } from "../router.js";

interface Pending {
  user_code: string;
  project_id: string;
  project_name: string;
  client_label: string;
  scopes: string[];
  expires_at: string;
}

const SCOPE_LABEL: Record<string, string> = { read: "读取项目上下文、任务与决策", write: "创建与执行任务、发布决策与阻塞、提交待验收" };

export function DeviceCodePage({ code, session }: { code: string; session: SessionView }) {
  const [input, setInput] = useState(code);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    api<Pending>("GET", `/device-codes/${encodeURIComponent(code)}`).then(setPending, (e: ApiError) => setError(e.message));
  }, [code]);

  function lookup(e: FormEvent) {
    e.preventDefault();
    go(`/device/${input.trim()}`);
  }

  async function decide(approve: boolean) {
    if (!pending) return;
    try {
      await api("POST", `/device-codes/${pending.user_code}/${approve ? "approve" : "deny"}`);
      setDone(approve ? "已批准。回到终端，Connector 会自动完成登录。" : "已拒绝该请求。");
      setPending(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <>
      <h1>授权 Agent 连接</h1>
      {done && <p className="notice">{done} {done.startsWith("已批准") && pending === null && <a href="#/projects">返回项目</a>}</p>}
      {!code && (
        <form onSubmit={lookup} className="row">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="终端里显示的确认码，如 BCDF-GHJK" required />
          <button>查找</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      {pending && (
        <section className="panel">
          <p>确认码 <code>{pending.user_code}</code> 请求以你的身份（{session.user.display_name}）连接：</p>
          <ul>
            <li>项目：<strong>{pending.project_name}</strong></li>
            <li>设备 / 客户端：<strong>{pending.client_label}</strong></li>
            <li>权限：{pending.scopes.map((s) => SCOPE_LABEL[s] ?? s).join("；")}</li>
          </ul>
          <p className="muted">Agent 不能验收任务、管理成员或访问其他项目。只有在你刚刚在自己的终端发起了这次登录时才批准。有效期至 {formatTime(pending.expires_at, session.user.timezone)}。</p>
          <div className="row">
            <button onClick={() => decide(true)}>批准</button>
            <button className="link danger" onClick={() => decide(false)}>拒绝</button>
          </div>
        </section>
      )}
    </>
  );
}
