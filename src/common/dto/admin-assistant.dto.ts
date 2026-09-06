export type AdminCapabilityDto = {
  id: string;
  section: string;
  title: string;
  path: string | null;
  icon: string;
  summary: string;
  tools: string[];
  ios: string;
};
export type AdminAssistantActionDto = {
  id: string;
  operation: string;
  title: string;
  path: string;
  /** Human-reviewable, server-owned snapshots. Never rendered as HTML. */
  before: string;
  changes: string;
  status: string;
  resultMessage: string | null;
  expiresAt: string;
};
export type AdminAssistantTurnDto = {
  id: string;
  question: string;
  answer: string | null;
  status: string;
  createdAt: string;
  sources: Array<{ tool: string; url: string | null; fetchedAt: string }>;
  actions: AdminAssistantActionDto[];
};
export type AdminAssistantWorkspaceDto = {
  environment: string;
  configured: boolean;
  capabilities: AdminCapabilityDto[];
  actions: Array<{ name: string; description: string }>;
  turns: AdminAssistantTurnDto[];
};
