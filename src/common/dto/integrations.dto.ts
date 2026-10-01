export type IntegrationBucketAllowanceDto = {
  limitMicros: number;
  committedMicros: number;
  remainingMicros: number;
  pendingMicros: number;
};

export type IntegrationAllowanceDto = {
  regular: IntegrationBucketAllowanceDto;
  expensive: IntegrationBucketAllowanceDto;
  resetsAt: string;
};

/** Public fields only. Never store relationship or DM permission in this DTO. */
export type XProfilePreviewDto = {
  id: string;
  username: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  websiteUrl: string | null;
  verified: boolean;
  followers: number | null;
  following: number | null;
  fetchedAt: string;
  expiresAt: string;
};

export type XAuthorMetricsDto = {
  postId: string;
  externalUrl: string;
  fetchedAt: string;
  expiresAt: string;
  likes?: number;
  replies?: number;
  reposts?: number;
  quotes?: number;
  impressions?: number;
};

export type IntegrationCapabilityDto = {
  provider: "x" | "pickax" | "linkedin" | "youtube" | "rumble";
  action: string;
  state:
    | "supported"
    | "unsupported"
    | "awaiting_permission"
    | "temporarily_unavailable"
    | "unknown";
  requiredScopes: string[];
  unitCostMicros: number | null;
  billingUnit: "request" | "resource" | "quota" | "unknown";
  priceVersion: string | null;
  reason: string | null;
};

/** Viewer-specific. Never include in a public snapshot or shared HTTP cache. */
export type XProfileContextDto = {
  targetId: string;
  followsYou: boolean;
  following: boolean;
  messageUrl: string | null;
  expiresAt: string;
};

export type XNewsDigestDto = {
  items: Array<{
    id: string;
    title: string;
    summary: string | null;
    sourceUrl: string;
    disclaimer: string | null;
  }>;
  fetchedAt: string;
  expiresAt: string;
};

export type IntegrationSpendDiagnosticsDto = {
  month: string;
  groups: Array<{
    provider: string;
    bucket: string;
    status: string;
    priceVersion: string;
    reservedMicros: number;
    chargedMicros: number;
    publicationCount: number;
    operationCount: number;
  }>;
  pending: Array<{
    id: string;
    userId: string | null;
    provider: string;
    action: string;
    bucket: string;
    status: string;
    reservedMicros: number;
    chargedMicros: number | null;
    createdAt: string;
    priceVersion: string;
  }>;
  limits: {
    enabled: boolean;
    companyMonthlyMicros: number;
    companyDailyMicros: number;
    xMonthlyMicros: number;
    fundedReserveMicros: number;
    removalHeadroomMicros: number;
  };
};

export type IntegrationReconciliationResultDto = {
  id: string;
  status: "settled" | "released";
  chargedMicros: number;
};

export type IntegrationSpendControlDto = {
  revision: number;
  paused: boolean;
  companyMonthlyMicros: number | null;
  companyDailyMicros: number | null;
  xMonthlyMicros: number | null;
  reserveMonthlyMicros: number | null;
};

export type IntegrationOperationsDto = {
  control: IntegrationSpendControlDto;
  alerts: Array<{
    key: string;
    severity: string;
    message: string;
    openedAt: string;
    observedAt: string;
  }>;
  changes: Array<{
    id: string;
    adminUserId: string;
    revision: number;
    reason: string;
    createdAt: string;
  }>;
};

export type XPublishingWorkspaceDto = {
  sourceHash: string;
  text: string;
  username: string | null;
  available: boolean;
  reason: string | null;
  canQuote: boolean;
  canLongText: boolean;
  canEdit: boolean;
  postMaxMicros: number | null;
  mediaMaxMicros: number | null;
  mediaCount: number;
  hasPoll: boolean;
  remoteUrl: string | null;
  confirmedUrls: string[];
  needsAttention: boolean;
  allowance: IntegrationAllowanceDto;
};
