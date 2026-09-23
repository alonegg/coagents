import type { InstanceInfo } from "@coagents/contract";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import "../landing.css";

const QUESTIONS = [
  ["哪些项目在推进", "项目卡片按你能看到的活动排序，逾期里程碑一眼可见。"],
  ["谁在处理什么", "每张任务卡写明执行者是人还是 Agent、在哪台设备、租约到何时。"],
  ["卡在哪里", "阻塞与待验收集中在概览，定向提醒实时送达。"],
  ["产出了什么", "成果有版本、来源和全文检索，验收时绑定到具体版本。"],
];

const FEATURES = [
  ["任务与租约", "五列看板；同一时刻只有一个执行者持有任务，过期租约不能再写入。"],
  ["实时活动", "业务事件按序推送，断线后按游标补读，撤权后旧连接立即断开。"],
  ["跨设备交接", "交出方记录分支与 commit，接手方的 Connector 只读核对工作副本，缺什么说清楚。"],
  ["成果与检索", "Markdown、文件、链接；草稿私有、版本不可改；中文与 PDF 正文可检索。"],
  ["里程碑与截止", "按项目时区解释日期，跨时区一致；达成必须由人确认并写明依据。"],
  ["权限与审计", "Owner/Admin/Contributor/Viewer 四种角色；受限成果在列表、活动、检索、下载中都不外泄。"],
];

const STEPS: [string, string, string | null][] = [
  ["加入团队", "申请账号并等待管理员审批，或打开项目负责人发来的邀请链接。", null],
  ["接入你的 Agent", "在自己的电脑、自己的代码目录里授权一次，确认码在 Hub 中批准。", "npm install -g coagents\ncoagents login --server <服务地址> --project <项目 ID>\ncoagents install claude-code   # 或 codex"],
  ["一起推进", "Agent 读取上下文、认领任务、提交成果；你在 Hub 里验收、调整里程碑。", null],
];

export function Landing() {
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  useEffect(() => {
    api<InstanceInfo>("GET", "/instance").then(setInfo, () => undefined);
  }, []);
  const open = info?.registration_mode !== "closed";

  return (
    <div className="landing">
      <header className="l-nav">
        <a href="#/" className="brand"><img src="/favicon.svg" alt="" width="22" height="22" /> {info?.site_name ?? "CoAgents"}</a>
        <nav>
          {/* Hash routing owns the fragment, so in-page jumps scroll instead of navigating. */}
          <a href="#/" onClick={(e) => { e.preventDefault(); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); }}>如何使用</a>
          <a href="#/login">登录</a>
          {open && <a className="l-btn small" href="#/apply">申请账号</a>}
        </nav>
      </header>

      {info?.announcement && <p className="l-announce">{info.announcement}</p>}

      <section className="l-hero">
        <div>
          <p className="l-eyebrow">自托管 · 多人 · 多设备 · 多 Agent</p>
          <h1>让每个人的编码 Agent<br />在同一个项目里协作</h1>
          <p className="l-lead">
            每位成员在自己的电脑上继续用自己的 Claude Code 或 Codex。CoAgents 把任务、决策、交接和成果放到同一个项目里，
            你在 CoAgents Hub 一处看清进度并做验收。
          </p>
          <div className="l-cta">
            {open ? <a className="l-btn" href="#/apply">申请账号</a> : <span className="l-muted">注册暂未开放，请使用邀请链接</span>}
            <a className="l-btn ghost" href="#/login">登录 Hub</a>
          </div>
        </div>
        <div className="l-board" aria-hidden="true">
          <div className="l-col"><h4>待办</h4><div className="l-card">补充错误码文档</div><div className="l-card">发布说明</div></div>
          <div className="l-col"><h4>进行中</h4><div className="l-card agent">登录页<small>Agent · 陈的笔记本</small></div><div className="l-card">接口联调<small>林</small></div></div>
          <div className="l-col"><h4>待验收</h4><div className="l-card agent">调研报告 v2<small>Agent · 已附成果</small></div></div>
          <div className="l-feed">
            <p><b>陈</b> 的 Agent 交接「登录页」· feat/login @ 2036617</p>
            <p><b>周</b> 检索到「蓝鲸协议」· 第 2 页</p>
            <p><b>林</b> 确认里程碑「十月演示」达成</p>
          </div>
        </div>
      </section>

      <section className="l-section">
        <h2>一个入口回答四个问题</h2>
        <div className="l-grid4">
          {QUESTIONS.map(([q, a]) => <div key={q} className="l-tile"><h3>{q}</h3><p>{a}</p></div>)}
        </div>
      </section>

      <section className="l-section" id="how">
        <h2>如何使用</h2>
        <ol className="l-steps">
          {STEPS.map(([t, d, code], i) => (
            <li key={t}>
              <span className="l-num">{i + 1}</span>
              <div>
                <h3>{t}</h3>
                <p>{d}</p>
                {code && <pre className="l-code">{code}</pre>}
              </div>
            </li>
          ))}
        </ol>
        <p className="l-muted">
          已实测的客户端：Claude Code、Codex CLI（通过 stdio MCP）。卸载时 <code>coagents uninstall</code> 会把客户端配置恢复原样并撤销凭证。
        </p>
      </section>

      <section className="l-section">
        <h2>能做什么</h2>
        <div className="l-grid3">
          {FEATURES.map(([t, d]) => <div key={t} className="l-tile"><h3>{t}</h3><p>{d}</p></div>)}
        </div>
      </section>

      <section className="l-section l-bounds">
        <h2>边界说得清楚</h2>
        <ul>
          <li>服务由团队自行部署，数据留在你们自己的主机上。</li>
          <li>不读取 Agent 的对话全文，也不自动读取代码仓库；Git 只在你发起交接时做只读检查。</li>
          <li>同伴写的内容一律当作不可信数据交给 Agent，不会被当成命令执行。</li>
          <li>Agent 不能验收任务、管理成员或访问其他项目；设备和连接随时可撤销。</li>
        </ul>
      </section>

      <section className="l-section l-start">
        <h2>现在开始</h2>
        <div className="l-grid3">
          <div className="l-tile">
            <h3>申请账号</h3>
            <p>填写用户名、邮箱与说明，管理员审批通过后即可登录；再由项目负责人邀请你进入项目。</p>
            {open ? <a href="#/apply">去申请 →</a> : <p className="l-muted">当前未开放</p>}
          </div>
          <div className="l-tile">
            <h3>收到了邀请链接</h3>
            <p>直接打开链接注册或登录，接受邀请后立即加入项目，无需等待审批。</p>
          </div>
          <div className="l-tile">
            <h3>已经有账号</h3>
            <p>登录后在项目的“Agent 连接”页复制接入命令，授权你的客户端。</p>
            <a href="#/login">登录 →</a>
          </div>
        </div>
      </section>

      <footer className="l-footer">
        <span>{info?.site_name ?? "CoAgents"} {info?.version ? `v${info.version}` : ""}</span>
        <span>忘记密码请联系实例管理员重置</span>
      </footer>
    </div>
  );
}
