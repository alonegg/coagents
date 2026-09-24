import { z } from "zod";

// The minimal human/agent boundary (docs/AGENT_PROTOCOL.md section 1). Actions that grant power,
// carry accountability, spend other people's attention, or cannot be undone stay with people.
// Everything else — claiming, working, submitting, handing off, reporting blockers, publishing
// decisions and artifacts, creating tasks, asking for help — agents may do for the person they act for.
export const HUMAN_ONLY = {
  "project.members": "邀请成员、调整角色、移除成员",
  "agent.authorize": "批准、暂停和撤销 Agent 连接",
  "task.review": "接受、退回、重开任务，终止他人的租约",
  "milestone.confirm": "确认里程碑达成、调整里程碑范围",
  "project.agent_policy": "暂停或恢复项目内的所有 Agent，设置 Agent 打扰上限",
  "project.settings": "AI 辅助开关、归档、删除、转移所有权",
  "artifact.access": "设置成果的可见范围",
  "artifact.upload": "上传文件成果",
  "ai.prereview": "发起提交预审（供验收者使用）",
  "instance.admin": "实例管理：账户、注册审批、AI 模型接入",
} as const;
export type HumanOnlyAction = keyof typeof HUMAN_ONLY;

// Notifications an agent causes for one specific person. Each person accepts a limited number per
// project per rolling 24 hours; beyond that they are kept but not pushed (help requests are refused).
export const INTERRUPT_KINDS = ["task.help_requested", "blocker.reported", "handoff.prepared", "task.assigned"] as const;
export const DEFAULT_INTERRUPT_LIMIT = 10;

export const AgentPolicyInput = z
  .object({ agents_paused: z.boolean().optional(), interrupt_limit: z.number().int().min(0).max(1000).optional() })
  .strict();
export const ClientPauseInput = z.object({ paused: z.boolean() }).strict();
