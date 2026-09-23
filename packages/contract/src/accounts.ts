import { z } from "zod";
import { AssignableRole, ProjectRole } from "./roles.js";

export const Username = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{1,31}$/, "2-32 chars: lowercase letters, digits, _ . -");
export const Password = z.string().min(10).max(256);
export const DisplayName = z.string().trim().min(1).max(64);
export const TimeZone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "unknown IANA time zone" },
);

export const LoginInput = z.object({ username: Username, password: z.string().min(1).max(256) }).strict();

export const RegisterInput = z
  .object({ username: Username, display_name: DisplayName, password: Password, timezone: TimeZone })
  .strict();

export const UserView = z.object({
  id: z.string(),
  username: Username,
  display_name: z.string(),
  timezone: z.string(),
  instance_role: z.enum(["maintainer", "member"]),
});
export type UserView = z.infer<typeof UserView>;

export const SessionView = z.object({
  user: UserView,
  device_id: z.string(),
  csrf_token: z.string(),
});
export type SessionView = z.infer<typeof SessionView>;

export const CreateProjectInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(5000).default(""),
    timezone: TimeZone.optional(),
  })
  .strict();

export const ProjectView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  lifecycle: z.enum(["active", "archived"]),
  timezone: z.string(),
  due_at: z.string().nullable(),
  role: ProjectRole,
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProjectView = z.infer<typeof ProjectView>;

export const MemberView = z.object({
  user_id: z.string(),
  username: z.string(),
  display_name: z.string(),
  role: ProjectRole,
  joined_at: z.string(),
});
export type MemberView = z.infer<typeof MemberView>;

export const ChangeRoleInput = z.object({ role: AssignableRole }).strict();

export const CreateInvitationInput = z
  .object({
    role: AssignableRole,
    target_username: Username.optional(),
    expires_in_hours: z.number().int().min(1).max(24 * 14).default(72),
  })
  .strict();

export const InvitationView = z.object({
  id: z.string(),
  role: AssignableRole,
  target_username: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  state: z.enum(["pending", "accepted", "revoked", "expired"]),
});
export type InvitationView = z.infer<typeof InvitationView>;

// What a token holder may learn before accepting: enough to decide, nothing about members or content.
export const InvitationPreview = z.object({
  project_name: z.string(),
  role: AssignableRole,
  target_username: z.string().nullable(),
  expires_at: z.string(),
  transferable: z.boolean(),
});
export type InvitationPreview = z.infer<typeof InvitationPreview>;

export const TransferOwnershipInput = z.object({ user_id: z.string().min(1).max(64) }).strict();

export const DeviceView = z.object({
  id: z.string(),
  kind: z.enum(["browser", "connector"]),
  label: z.string(),
  created_at: z.string(),
  last_seen_at: z.string(),
  current: z.boolean(),
});
export type DeviceView = z.infer<typeof DeviceView>;

// Agent scopes. An agent's effective permissions are its user's current role intersected with these.
export const AgentScope = z.enum(["read", "write"]);
export type AgentScope = z.infer<typeof AgentScope>;

export const DeviceCodeRequest = z
  .object({
    project_id: z.string().min(1).max(64),
    client_label: z.string().trim().min(1).max(80),
    scopes: z.array(AgentScope).min(1).max(2),
  })
  .strict();

export const DeviceCodeGrant = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_url: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});
export type DeviceCodeGrant = z.infer<typeof DeviceCodeGrant>;

export const DeviceTokenResult = z.union([
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("approved"),
    agent_token: z.string(),
    client_id: z.string(),
    device_id: z.string(),
    project_id: z.string(),
    scopes: z.array(AgentScope),
  }),
]);
export type DeviceTokenResult = z.infer<typeof DeviceTokenResult>;

export const AgentConnectionView = z.object({
  id: z.string(),
  label: z.string(),
  user_id: z.string(),
  username: z.string(),
  device_id: z.string(),
  device_label: z.string(),
  scopes: z.array(AgentScope),
  created_at: z.string(),
  last_seen_at: z.string().nullable(),
  verified_at: z.string().nullable(),
  delivered_seq: z.number(),
  read_seq: z.number(),
});
export type AgentConnectionView = z.infer<typeof AgentConnectionView>;
