export type DelegationAccountDto = {
  id: string;
  username: string | null;
  name: string | null;
  accountKind: string;
};
export type DelegationScheduleDto = {
  frequency: "once" | "daily" | "weekly";
  time: string;
  timeZone: string;
  weekday: number;
  at?: string;
};
export type DelegationActionDto = {
  exportFormat?: string;
  id: string;
  operation: string;
  title: string;
  preview: string;
  body: string | null;
  status: string;
  receipt: string | null;
  path: string | null;
  sources: Array<{ title: string; url: string }>;
  createdAt: string;
};
export type DelegationRunDto = {
  id: string;
  status: string;
  summary: string | null;
  createdAt: string;
  completedAt: string | null;
  actions: DelegationActionDto[];
};
export type DelegationJobDto = {
  pendingCount?: number;
  nextRunCursor?: string | null;
  id: string;
  title: string;
  workflow: string;
  instruction: string;
  permission: string;
  actor: DelegationAccountDto;
  schedule: DelegationScheduleDto;
  status: string;
  nextRunAt: string | null;
  revision: number;
  createdAt: string;
  runs: DelegationRunDto[];
};
export type DelegationWorkspaceDto = {
  actionSchema: Record<string, unknown>;
  operations: Record<string, string[]>;
  configured: boolean;
  access: "admin";
  accounts: DelegationAccountDto[];
  workflows: Array<{ id: string; title: string; description: string }>;
  jobs: DelegationJobDto[];
  integrations: Array<{
    id: string;
    title: string;
    available: boolean;
    reason: string;
  }>;
};
