/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: menofhunger-api/src/common/dto/** (and module DTO files).
 * Regenerate with `npm run emit:contracts` from menofhunger-api/.
 *
 * Prisma enums are inlined as string-literal unions; server-only row/mapper
 * types are excluded.
 */

// ─── Prisma enums (inlined) ───────────────────────────────────────────────

export type BirthdayVisibility = 'none' | 'monthDay' | 'full'
export type CommunityGroupInviteStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired'
export type CommunityGroupJoinPolicy = 'open' | 'approval'
export type CommunityGroupMemberRole = 'owner' | 'moderator' | 'member'
export type CommunityGroupMemberStatus = 'active' | 'pending'
export type CrewInviteStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired'
export type CrewMemberRole = 'owner' | 'member'
export type FeedbackCategory = 'bug' | 'feature' | 'account' | 'other'
export type FeedbackStatus = 'new' | 'triaged' | 'resolved'
export type FollowVisibility = 'none' | 'all' | 'verified' | 'premium'
export type MessageParticipantRole = 'owner' | 'member'
export type MessageParticipantStatus = 'pending' | 'accepted'
export type NotificationKind = 'comment' | 'boost' | 'repost' | 'follow' | 'followed_post' | 'followed_article' | 'mention' | 'nudge' | 'poll_results_ready' | 'generic' | 'coin_transfer' | 'message' | 'group_join_request' | 'community_group_member_joined' | 'community_group_join_approved' | 'community_group_join_rejected' | 'community_group_member_removed' | 'community_group_disbanded' | 'crew_invite_received' | 'crew_invite_accepted' | 'crew_invite_declined' | 'crew_invite_cancelled' | 'crew_member_joined' | 'crew_member_left' | 'crew_member_kicked' | 'crew_owner_transferred' | 'crew_owner_transfer_vote' | 'crew_wall_mention' | 'crew_disbanded' | 'community_group_invite_received' | 'community_group_invite_accepted' | 'community_group_invite_declined' | 'community_group_invite_cancelled'
export type PostMediaKind = 'image' | 'gif' | 'video'
export type PostMediaSource = 'upload' | 'giphy'
export type PostVisibility = 'public' | 'verifiedOnly' | 'premiumOnly' | 'onlyMe'
export type ReportReason = 'other' | 'spam' | 'harassment' | 'hate' | 'sexual' | 'violence' | 'illegal'
export type ReportStatus = 'pending' | 'dismissed' | 'actionTaken'
export type ReportTargetType = 'post' | 'user'
export type VerificationRequestStatus = 'pending' | 'cancelled' | 'approved' | 'rejected'
export type VerifiedStatus = 'none' | 'identity' | 'manual'

// ─── src/common/dto/admin-analytics.dto.ts ─────────────────────────────────────

export type AnalyticsRange = '7d' | '30d' | '3m' | '1y' | 'all';

export type AnalyticsGranularity = 'day' | 'week' | 'month';

export type TimeSeriesPoint = { bucket: string; count: number };

export type AdminAnalyticsSummaryDto = {
  totalUsers: number;
  verifiedUsers: number;
  /** All-time public, regular, non-draft, non-deleted posts. */
  totalPublicPosts: number;
  premiumUsers: number;
  premiumPlusUsers: number;
  /** Users with at least one active (non-revoked, non-expired) subscription grant */
  usersWithActiveGrants: number;
  dau: number;
  mau: number;
  /** Sum of all user coin balances — total coins in the economy */
  totalCoinsInEconomy: number;
};

export type AdminAnalyticsTopPostDto = {
  id: string;
  bodyPreview: string;
  authorUsername: string;
  viewCount: number;
  boostCount: number;
  commentCount: number;
  reactionCount: number;
  createdAt: string;
};

export type AdminAnalyticsRetentionRow = {
  cohortWeek: string;
  size: number;
  w1: number;
  w4: number;
};

export type AdminAnalyticsEngagementDto = {
  /** Users who signed up 30–37 days ago */
  d30CohortSize: number;
  /** Of that cohort, how many were active in the last 7 days */
  d30RetainedCount: number;
  /** null when cohort is empty (no data yet) */
  d30RetentionPct: number | null;

  /** Users old enough to measure (7+ days since signup) */
  activationEligibleCount: number;
  /** Of those, how many had any activity in their first 7 days */
  activationCount: number;
  /** null when no eligible users yet */
  activationPct: number | null;

  /** Unique active users in the last 30 days (MAU) */
  creatorMauCount: number;
  /** Of MAU, how many posted, published an article, or hosted an active space */
  creatorCount: number;
  /** null when no MAU yet */
  creatorPct: number | null;

  avgFollowersPerUser: number;
  connectedUserCount: number;
  /** null when no users yet */
  connectedUserPct: number | null;
};

export type AdminAnalyticsTopArticleDto = {
  id: string;
  title: string;
  slug: string;
  visibility: string;
  authorUsername: string;
  viewCount: number;
  boostCount: number;
  commentCount: number;
  reactionCount: number;
  publishedAt: string;
};

export type AdminAnalyticsArticleKpiDto = {
  /** All-time published article count */
  totalPublished: number;
  /** All-time draft count */
  totalDrafts: number;
  /** Unique authors who have published at least one article */
  uniqueAuthors: number;
  /** Article views recorded in the selected range */
  totalViewsInRange: number;
  /** Article boosts recorded in the selected range */
  totalBoostsInRange: number;
  /** Article reactions recorded in the selected range */
  totalReactionsInRange: number;
  /** Article comments (non-deleted) created in the selected range */
  totalCommentsInRange: number;
  /** Average views per published article for articles published in the range */
  avgViewsPerArticle: number;
};

export type AdminAnalyticsArticlesDto = {
  kpis: AdminAnalyticsArticleKpiDto;
  /** Time series — articles published per bucket in the selected range */
  published: TimeSeriesPoint[];
  /** Time series — article views recorded per bucket in the selected range */
  views: TimeSeriesPoint[];
  /** Published (non-deleted) article count by visibility tier (all time) */
  byVisibility: Record<string, number>;
  /** Top articles by view count in the selected range */
  topArticles: AdminAnalyticsTopArticleDto[];
};

export type AdminAnalyticsMonetizationDto = {
  free: number;
  payingPremium: number;
  payingPremiumPlus: number;
  compedPremium: number;
  compedPremiumPlus: number;
  byStatus: Record<string, number>;
};

export type AdminAnalyticsCoinsDto = {
  /** Sum of all user coin balances (all time, all non-banned users). */
  totalInEconomy: number;
  /** Coins minted from streak rewards in the selected range. */
  mintedInRange: number;
  /** Coins sent peer-to-peer in the selected range. */
  transferredInRange: number;
  /** Distinct users who earned streak coins in the selected range. */
  uniqueEarnersInRange: number;
  /** Distinct users who sent coins to others in the selected range. */
  uniqueSendersInRange: number;
  /** Coins minted per time bucket in the selected range. */
  minted: TimeSeriesPoint[];
  /** Coins minted grouped by multiplier amount (1, 2, 3, 4). */
  mintedByMultiplier: Record<string, number>;
  /**
   * Velocity ratio: transferred / minted in the selected range.
   * > 1 means more coins are moving than being created (unusual; could indicate re-circling).
   * Null when minted = 0.
   */
  velocityRatio: number | null;
  /**
   * Gini coefficient of the all-time coin distribution (0 = perfect equality, 1 = extreme inequality).
   * Computed over all non-banned users with coins > 0.
   * Null when there are no holders.
   */
  giniCoefficient: number | null;
};

export type AdminAnalyticsGroupsTopRowDto = {
  id: string;
  slug: string;
  name: string;
  memberCount: number;
  rootPostsInRange: number;
  /** % of roots (in range) that got ≥1 reply within 24h; null when no roots in range. */
  replyRate24hPct: number | null;
};

export type AdminAnalyticsGroupsDto = {
  /** Distinct non-banned users with at least one active group membership. */
  usersInAnyGroup: number;
  /** usersInAnyGroup ÷ total non-banned users (null if no users). */
  pctUsersInAnyGroup: number | null;
  /** Groups not soft-deleted. */
  activeGroups: number;
  /** Active memberships where member row was created in range (open joins; approximates growth). */
  newActiveMembershipsInRange: number;
  pendingApprovals: number;
  groupRootPostsInRange: number;
  groupRepliesInRange: number;
  /** Among group root posts created in range: % with ≥1 reply within 24h. */
  pctGroupRootsWithReplyWithin24h: number | null;
  topGroups: AdminAnalyticsGroupsTopRowDto[];
};

export type AdminAnalyticsSpacesTopRowDto = {
  id: string;
  ownerId: string;
  ownerUsername: string;
  title: string;
  mode: string;
  isActive: boolean;
  createdAt: string;
};

export type AdminAnalyticsSpacesDto = {
  /** All-time total spaces. */
  totalSpaces: number;
  /** Spaces currently marked isActive = true. */
  activeSpaces: number;
  /** Spaces created within the selected range. */
  spacesCreatedInRange: number;
  /** All-time spaces by current mode (NONE / WATCH_PARTY / RADIO). */
  byMode: Record<string, number>;
  /** Time series — spaces created per bucket in the selected range. */
  created: TimeSeriesPoint[];
  /** Currently active spaces, most recently updated first. */
  topSpaces: AdminAnalyticsSpacesTopRowDto[];
};

export type AdminAnalyticsAIDto = {
  /** All MarvinUsageEvent rows in range (success + errors). */
  totalInteractionsInRange: number;
  /** Rows where errorCode IS NULL (actual AI responses delivered). */
  successfulInteractionsInRange: number;
  /** Distinct users who triggered Marv in range. */
  uniqueUsersInRange: number;
  /** Sum of creditsSpent for all events in range. */
  creditsSpentInRange: number;
  /** Sum of estimatedCostUsd in range; null when no cost data yet. */
  estimatedCostUsdInRange: number | null;
  /** Average latencyMs for successful events; null when no data. */
  avgLatencyMsInRange: number | null;
  /** Count by MarvinSource: "public_thread" | "private_session". */
  bySource: Record<string, number>;
  /** Count by effectiveMode for successful events: "fast" | "regular" | "smart". */
  byEffectiveMode: Record<string, number>;
  /** Count by outcome for all events: "success" | errorCode string. */
  byOutcome: Record<string, number>;
  /** Time series of successful interactions per granularity bucket. */
  interactions: TimeSeriesPoint[];
};

export type AdminAnalyticsDto = {
  range: AnalyticsRange;
  granularity: AnalyticsGranularity;
  summary: AdminAnalyticsSummaryDto;
  signups: TimeSeriesPoint[];
  /** Top public regular posts by all-time denormalized view count. */
  topPostsAllTime: AdminAnalyticsTopPostDto[];
  /** Counts of regular (non-draft, non-deleted) posts per visibility for the selected range. */
  postsByVisibility: Record<string, number>;
  /** Time series of regular posts by human (non-bot) users, visible to others (excludes onlyMe). */
  posts: TimeSeriesPoint[];
  /** Time series of regular posts by AI/bot users in the selected range. */
  aiPosts: TimeSeriesPoint[];
  checkins: TimeSeriesPoint[];
  /** Time series of messages sent by human (non-bot) users. */
  messages: TimeSeriesPoint[];
  /** Time series of messages sent by AI/bot users. */
  aiMessages: TimeSeriesPoint[];
  follows: TimeSeriesPoint[];
  retention: AdminAnalyticsRetentionRow[];
  engagement: AdminAnalyticsEngagementDto;
  monetization: AdminAnalyticsMonetizationDto;
  coins: AdminAnalyticsCoinsDto;
  articles: AdminAnalyticsArticlesDto;
  groups: AdminAnalyticsGroupsDto;
  spaces: AdminAnalyticsSpacesDto;
  ai: AdminAnalyticsAIDto;
  asOf: string;
};

// ─── src/common/dto/admin-email-samples.dto.ts ─────────────────────────────────

export type AdminEmailSampleTypeDto =
  | 'daily_digest'
  | 'weekly_digest'
  | 'new_notifications'
  | 'instant_high_signal'
  | 'streak_reminder';

export type AdminEmailSampleSendResultDto = {
  sent: boolean;
  reason: string | null;
  type: AdminEmailSampleTypeDto;
};

// ─── src/common/dto/affiliate.dto.ts ───────────────────────────────────────────

export type AffiliateEarningType = 'signup' | 'verified' | 'premium' | 'premium60d';

export type AffiliateEarningDto = {
  id: string;
  recruitUserId: string;
  recruitUsername: string | null;
  recruitName: string | null;
  type: AffiliateEarningType;
  /** Amount in cents (USD). */
  amountCents: number;
  createdAt: string;
  settledAt: string | null;
};

export type AffiliateSummaryDto =
  | {
      isAffiliate: false;
    }
  | {
      isAffiliate: true;
      pendingCents: number;
      settledCents: number;
      /** Total lifetime earnings (pending + settled). */
      totalCents: number;
      /** Minimum pending balance required to trigger a payout. */
      minPayoutCents: number;
      /** Per-member lifetime earnings cap. */
      capCents: number;
      /** True when totalCents >= capCents. */
      capReached: boolean;
      counts: {
        signups: number;
        verified: number;
        premium: number;
        premium60d: number;
      };
      earnings: AffiliateEarningDto[];
    };

export type AdminAffiliateUserDto = {
  userId: string;
  username: string | null;
  name: string | null;
  affiliateAt: string;
  recruitCount: number;
  pendingCents: number;
  settledCents: number;
  /** Total lifetime earnings (pending + settled). */
  totalCents: number;
  /** Per-member lifetime earnings cap. */
  capCents: number;
  /** True when totalCents >= capCents. */
  capReached: boolean;
};

export type AdminAffiliateSettleDto = {
  settledCount: number;
  settledCents: number;
};

// ─── src/common/dto/article.dto.ts ─────────────────────────────────────────────

export type ArticleReactionSummaryDto = {
  reactionId: string;
  emoji: string;
  count: number;
  viewerHasReacted: boolean;
};

export type ArticleAuthorDto = {
  id: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  /** Per-author override bio shown at the bottom of articles. Falls back to `bio` if null. */
  articleBio: string | null;
  avatarUrl: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: VerifiedStatus;
  orgAffiliations: Array<{ id: string; username: string | null; name: string | null; avatarUrl: string | null }>;
};

export type ArticleSharePreviewDto = {
  id: string;
  title: string;
  excerpt: string | null;
  thumbnailUrl: string | null;
  visibility: PostVisibility;
  publishedAt: string | null;
  author: Pick<ArticleAuthorDto, 'id' | 'username' | 'name' | 'avatarUrl' | 'verifiedStatus' | 'premium' | 'premiumPlus'>;
};

export type ArticleCommentDto = {
  id: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  body: string;
  articleId: string;
  parentId: string | null;
  replyCount: number;
  author: ArticleAuthorDto;
  reactions: ArticleReactionSummaryDto[];
  replies?: ArticleCommentDto[];
  viewerHasReacted?: boolean;
};

export type ArticleTagDto = {
  /** Normalized slug (lowercase, alphanumeric + hyphens). Used as URL param. */
  tag: string;
  /** Display label as the author typed it (may have uppercase). */
  label: string;
};

export type ArticleDto = {
  id: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  title: string;
  slug: string;
  body: string;
  excerpt: string | null;
  thumbnailUrl: string | null;
  visibility: PostVisibility;
  isDraft: boolean;
  lastSavedAt: string;
  boostCount: number;
  commentCount: number;
  viewCount: number;
  readingTimeMinutes: number;
  author: ArticleAuthorDto;
  reactions: ArticleReactionSummaryDto[];
  tags: ArticleTagDto[];
  viewerHasBoosted?: boolean;
  /** False when the viewer's tier does not grant access to this article (preview-only). */
  viewerCanAccess: boolean;
};

// ─── src/common/dto/billing.dto.ts ─────────────────────────────────────────────

export type BillingTier = 'premium' | 'premiumPlus';

export type SubscriptionGrantSource = 'admin' | 'referral';

export type ActiveSubscriptionGrantDto = {
  id: string;
  tier: BillingTier;
  source: SubscriptionGrantSource;
  months: number;
  startsAt: string;
  endsAt: string;
  reason: string | null;
};

export type BillingMeDto = {
  premium: boolean;
  premiumPlus: boolean;
  verified: boolean;
  /** Stripe subscription status (when known). */
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  /** When the current Stripe billing period ends (null if no active Stripe sub). */
  currentPeriodEnd: string | null;
  /** Latest access expiry across Stripe + active grants. */
  effectiveExpiresAt: string | null;
  /** Active (non-expired, non-revoked) subscription grants. */
  grants: ActiveSubscriptionGrantDto[];
  /** Referral code set by this user (premium-only). */
  referralCode: string | null;
  /** Who recruited this user (null if no recruiter). */
  recruiter: {
    id: string;
    username: string | null;
    name: string | null;
    avatarUrl: string | null;
    premium: boolean;
    premiumPlus: boolean;
    verifiedStatus: 'none' | 'identity' | 'manual';
  } | null;
  /** How many users this user has recruited. */
  recruitCount: number;
  /** Whether the one-time referral bonus has been granted to this user. */
  referralBonusGranted: boolean;
};

export type BillingCheckoutSessionDto = {
  url: string;
};

export type BillingPortalSessionDto = {
  url: string;
};

/** Summary of banked free months for admin grant management UI. */
export type AdminGrantSummaryDto = {
  premiumMonthsRemaining: number;
  premiumPlusMonthsRemaining: number;
};

// ─── src/common/dto/coin-transfer.dto.ts ───────────────────────────────────────

export type CoinTransferCounterpartyDto = {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type CoinTransferDto = {
  id: string;
  createdAt: string;
  amount: number;
  note: string | null;
  direction: 'sent' | 'received' | 'admin_added' | 'admin_removed' | 'streak_reward' | 'verification_gift';
  counterparty: CoinTransferCounterpartyDto;
};

export type CoinTransferReceiptPartyDto = {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export type CoinTransferReceiptDto = {
  id: string;
  createdAt: string;
  amount: number;
  note: string | null;
  direction: 'sent' | 'received' | 'admin_added' | 'admin_removed' | 'streak_reward' | 'verification_gift';
  sender: CoinTransferReceiptPartyDto;
  recipient: CoinTransferReceiptPartyDto;
  counterparty: CoinTransferCounterpartyDto;
};

export type TransferCoinsRequest = {
  recipientUsername: string;
  amount: number;
  note?: string | null;
};

export type TransferCoinsResponse = {
  transferId: string;
  amount: number;
  recipientUsername: string;
  senderBalanceAfter: number;
};

// ─── src/common/dto/community-group.dto.ts ─────────────────────────────────────

export type CommunityGroupPreviewDto = {
  id: string;
  slug: string;
  name: string;
  descriptionPreview: string;
  coverImageUrl: string | null;
  avatarImageUrl: string | null;
  joinPolicy: CommunityGroupJoinPolicy;
  memberCount: number;
  viewerMembership: {
    status: CommunityGroupMemberStatus;
    role: CommunityGroupMemberRole;
  } | null;
  viewerPendingApproval: boolean;
};

export type CommunityGroupShellDto = {
  id: string;
  slug: string;
  name: string;
  description: string;
  rules: string | null;
  coverImageUrl: string | null;
  avatarImageUrl: string | null;
  joinPolicy: CommunityGroupJoinPolicy;
  memberCount: number;
  isFeatured: boolean;
  featuredOrder: number;
  createdAt: string;
  /** Present when viewer is authenticated; null if not a member or pending. */
  viewerMembership: {
    status: CommunityGroupMemberStatus;
    role: CommunityGroupMemberRole;
  } | null;
  viewerPendingApproval: boolean;
  /** Number of pending join requests. Only populated for owners and moderators. */
  pendingMemberCount?: number;
  /** Number of pending outbound invites issued for this group. Only populated for owners and moderators. */
  pendingInviteCount?: number;
};

export type CommunityGroupMemberUserDto = {
  userId: string;
  username: string | null;
  name: string | null;
  role: CommunityGroupMemberRole;
  status: CommunityGroupMemberStatus;
  joinedAt: string;
};

/** Active member row for group directory (avatar from R2 in API layer). */
export type CommunityGroupMemberListItemDto = {
  userId: string;
  username: string | null;
  name: string | null;
  role: CommunityGroupMemberRole;
  avatarUrl: string | null;
  joinedAt: string;
};

/**
 * Lightweight reference to the group on a CommunityGroupInviteDto. Excludes
 * member counts/policy details that the inbox UI does not need.
 */
export type CommunityGroupInviteGroupRefDto = {
  id: string;
  slug: string;
  name: string;
  descriptionPreview: string;
  avatarImageUrl: string | null;
  coverImageUrl: string | null;
  joinPolicy: CommunityGroupJoinPolicy;
  memberCount: number;
};

export type CommunityGroupInviteDto = {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  status: CommunityGroupInviteStatus;
  message: string | null;
  /** ISO; only set when the invitee previously declined this same row. */
  lastDeclinedAt: string | null;
  group: CommunityGroupInviteGroupRefDto;
  invitedBy: UserListDto;
  invitee: UserListDto;
};

/**
 * Rich invite-status hint returned by the picker so the inviter UI can render
 * "Already a member", "Pending invite", "Declined — try again on Mar 14", etc.
 */
export type CommunityGroupInvitableUserStatus =
  | { kind: 'invitable' }
  | { kind: 'self' }
  | { kind: 'banned' }
  | { kind: 'member'; role: CommunityGroupMemberRole }
  | { kind: 'pending_join_request' }
  | { kind: 'pending_invite'; inviteId: string; lastNotifiedAt: string | null }
  | { kind: 'declined_cooldown'; inviteId: string; declinedAt: string; canReinviteAt: string }
  | { kind: 'declined_invitable'; inviteId: string; declinedAt: string };

export type CommunityGroupInvitableUserDto = {
  user: UserListDto;
  inviteStatus: CommunityGroupInvitableUserStatus;
};

// ─── src/common/dto/crew.dto.ts ────────────────────────────────────────────────

/**
 * Public-facing Crew shell (shown on /c/:slug, profile crew pill, etc.).
 * Does NOT include anything private (wall contents, invite list, etc.).
 */
export type CrewPublicDto = {
  id: string;
  slug: string;
  /** null means "Untitled Crew" — renderers should display the friendly fallback. */
  name: string | null;
  tagline: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  memberCount: number;
  createdAt: string;
  owner: UserListDto;
  members: CrewMemberListItemDto[];
};

/**
 * Private Crew shell (returned from GET /crew/me to members only).
 * Includes wall conversation id and viewer-specific metadata.
 */
export type CrewPrivateDto = CrewPublicDto & {
  wallConversationId: string;
  designatedSuccessorUserId: string | null;
  viewerRole: CrewMemberRole;
  pendingInviteCount: number;
};

/**
 * Crew member list row. Embeds the full `UserListDto` so renderers can show
 * verified checks, premium tints, org affiliations, etc. without an extra fetch.
 */
export type CrewMemberListItemDto = {
  user: UserListDto;
  role: CrewMemberRole;
  joinedAt: string;
  isDesignatedSuccessor: boolean;
};

export type CrewInviteDto = {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: CrewInviteStatus;
  message: string | null;
  /** Null for founding invites (the crew does not exist yet). */
  crew: CrewPublicDto | null;
  invitedBy: UserListDto;
  invitee: UserListDto;
};

// ─── src/common/dto/daily-content.dto.ts ───────────────────────────────────────

export type DailyQuoteKindDto = 'scripture' | 'quote' | 'paraphrase';

export type DailyQuoteDto = {
  id: string;
  kind: DailyQuoteKindDto;
  author: string;
  reference: string | null;
  text: string;
  isParaphrase: boolean;
  tradition?: string;
  note?: string;
  sourceUrl?: string;
};

export type DailyContentTodayDto = {
  /** Eastern Time day key (YYYY-MM-DD). */
  dayKey: string;
  quote: DailyQuoteDto | null;
  quoteRefreshedAt: string | null;
  websters1828: Websters1828WordOfDayDto | null;
  websters1828RefreshedAt: string | null;
  websters1828RecheckedAt: string | null;
};

// ─── src/common/dto/feedback.dto.ts ────────────────────────────────────────────

export type FeedbackDto = {
  id: string;
  createdAt: string;
  updatedAt: string;
  category: FeedbackCategory;
  status: FeedbackStatus;
  email: string | null;
  subject: string;
  details: string;
};

export type FeedbackAdminDto = FeedbackDto & {
  adminNote: string | null;
  user: {
    id: string;
    username: string | null;
    name: string | null;
    avatarUrl: string | null;
  } | null;
};

// ─── src/common/dto/hashtag.dto.ts ─────────────────────────────────────────────

export type HashtagResultDto = {
  /** Canonical lowercase tag value (no '#'). */
  value: string;
  /** Display label (most common casing). */
  label: string;
  /** Recent usage count (within the trending window) or overall usage count (for autocomplete). */
  usageCount: number;
};

// ─── src/common/dto/landing.dto.ts ─────────────────────────────────────────────

export type LandingStatsDto = {
  /** All-time public, regular, non-draft, non-deleted posts. */
  publicPostCount: number;
  /** Verified, non-org, non-banned users with completed usernames. */
  verifiedMenCount: number;
};

export type LandingTopPostDto = PostDto & {
  /** Distinct logged-in/anonymous viewers active on this post in the last 7 days. */
  weeklyViewCount: number;
};

export type LandingSnapshotDto = {
  stats: LandingStatsDto;
  recentlyActiveMen: UserListDto[];
  topPostsThisWeek: LandingTopPostDto[];
  trendingArticles: ArticleDto[];
  asOf: string;
};

// ─── src/common/dto/marvin/marvin-credit-summary.dto.ts ────────────────────────

/**
 * Snapshot of the requester's Marv credit bucket. Returned by `GET /marvin/me` and emitted
 * via the `marv:credits-updated` realtime event after any reply (or refill).
 */
export type MarvinCreditSummaryDto = {
  /** Current balance after lazy refill. May be fractional during partial accrual. */
  credits: number;
  /** Maximum bucket size — credits accrue up to this cap then stop. */
  maxCredits: number;
  /** Refill rate in credits per 24 hours. */
  creditsPerDay: number;
  /** ISO timestamp of the last balance write (used to compute next refill). */
  lastRefilledAt: string;
};

// ─── src/common/dto/marvin/marvin-me.dto.ts ────────────────────────────────────

/**
 * Combined "everything the chat page / settings need" envelope for the requesting user.
 * Backed by `GET /marvin/me`.
 */
export type MarvinMeDto = {
  /** Whether Marv is enabled for this app + this user (admin can disable per user). */
  enabled: boolean;
  /** True when the user is on a tier that grants AI replies (premium / premium plus). */
  isPremium: boolean;
  /** Mode this user picked in settings. The composer + processor honor this by default. */
  preferredMode: MarvinModeDto;
  /** Latest credit-bucket snapshot. */
  credits: MarvinCreditSummaryDto;
  /** Marv bot user reference for the chat-page pinned row. */
  marv: {
    userId: string;
    username: string;
    displayName: string;
    /**
     * Resolved public avatar URL for Marv, or `null` when no avatar is set
     * (the pinned row falls back to a styled icon in that case).
     */
    avatarUrl: string | null;
  } | null;
};

/**
 * Body for `PATCH /marvin/me/preferences`. Single field for now; add more as we go.
 */
export type MarvinUpdatePreferencesBodyDto = {
  preferredMode?: MarvinModeDto;
};

// ─── src/common/dto/marvin/marvin-mode.dto.ts ──────────────────────────────────

/**
 * User-facing Marv reply-mode tier. Mirrors the `MarvinMode` Prisma enum but is duplicated
 * here as a literal-string union so it travels cleanly to the web client without leaking
 * Prisma types across the API contract.
 */
export type MarvinModeDto = 'fast' | 'regular' | 'smart';

/** Source channel the request originated from. */
export type MarvinSourceDto = 'public_thread' | 'private_session';

// ─── src/common/dto/marvin/marvin-usage-event.dto.ts ───────────────────────────

/**
 * Single Marv interaction event — successful AI reply, canned reply, or failure. Mirrors
 * the `MarvinUsageEvent` Prisma row but with friendly types (string ISO timestamps,
 * optional fields nullable rather than undefined) for the API contract.
 */
export type MarvinUsageEventDto = {
  id: string;
  userId: string;
  source: MarvinSourceDto;
  /** Post id (public) or conversation id (private). */
  sourceId: string;
  rootPostId: string | null;
  requestedMode: MarvinModeDto;
  effectiveMode: MarvinModeDto;
  creditsSpent: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  modelUsed: string | null;
  estimatedCostUsd: number | null;
  responseId: string | null;
  routingReason: string | null;
  errorCode: string | null;
  latencyMs: number | null;
  createdAt: string;
};

// ─── src/common/dto/metrics.dto.ts ─────────────────────────────────────────────

export type ActiveUsersMetricsDto = {
  /** Average daily active users over the last `dauWindowDays` days (rounded to an integer). */
  dau: number;
  /** Rolling monthly active users over the last `mauWindowDays` days. */
  mau: number;
  dauWindowDays: number;
  mauWindowDays: number;
  /** ISO timestamp of when the metric was computed. */
  asOf: string;
};

// ─── src/common/dto/notification-feed.dto.ts ───────────────────────────────────

export type NotificationGroupKind = 'comment' | 'boost' | 'repost' | 'follow' | 'followed_post' | 'nudge';

/**
 * A conservative grouped notification row built from strictly consecutive notifications.
 * `id` is the newest notification id in the group (stable key for rendering).
 */
export type NotificationGroupDto = {
  id: string;
  kind: NotificationGroupKind;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;

  /** Navigation subject when applicable. */
  subjectPostId: string | null;
  subjectUserId: string | null;

  /** Unique actors in newest->oldest order (max not enforced by API). */
  actors: NotificationActorDto[];
  actorCount: number;

  /** Number of underlying notifications represented by this group. */
  count: number;

  /** Latest body snippet (used for comment groups). */
  latestBody: string | null;

  /** Latest subject post preview (used for post-subject groups). */
  latestSubjectPostPreview: SubjectPostPreviewDto | null;

  /** When subject is a post, its visibility (used for UI tinting). */
  subjectPostVisibility: SubjectPostVisibility | null;

  /** Tier of subject (post or user) for unseen row highlight. */
  subjectTier: SubjectTier;
};

/**
 * Collapsed “new posts” row for followed-post notifications when bell is NOT enabled.
 * This is a UI affordance only; underlying notifications still exist for counts and read semantics.
 */
export type FollowedPostsRollupDto = {
  /** The newest underlying notification id (stable-ish render key). */
  id: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  /** Unique actors with new posts (newest->oldest). */
  actors: NotificationActorDto[];
  actorCount: number;
  /** Number of underlying followed-post notifications represented by this rollup. */
  count: number;
};

export type NotificationFeedItemDto =
  | { type: 'single'; notification: NotificationDto }
  | { type: 'group'; group: NotificationGroupDto }
  | { type: 'followed_posts_rollup'; rollup: FollowedPostsRollupDto };

/** Data shape for GET /notifications/new-posts. */
export type NotificationNewPostsFeedDto = {
  data: PostDto[];
  pagination: {
    nextCursor: string | null;
  };
};

// ─── src/common/dto/notification-preferences.dto.ts ────────────────────────────

export type NotificationPreferencesDto = {
  pushComment: boolean;
  pushBoost: boolean;
  pushFollow: boolean;
  pushMention: boolean;
  pushMessage: boolean;
  pushRepost: boolean;
  pushNudge: boolean;
  pushFollowedPost: boolean;
  /** Send a single push 24h after a reply if the recipient hasn't opened it yet. Once-per-notification, never spammed. */
  pushReplyNudge: boolean;
  /** Crew streak: push when the strict crew streak advances or breaks. Highest-signal push in the product. */
  pushCrewStreak: boolean;
  /** Group activity: push for join, approve/reject, remove, disband events. */
  pushGroupActivity: boolean;
  emailDigestDaily: boolean;
  emailDigestWeekly: boolean;
  emailNewNotifications: boolean;
  /** Optional: near-immediate emails for high-signal events (messages + mentions/replies). */
  emailInstantHighSignal: boolean;
  /** Evening reminder email when the user's check-in streak is at risk. */
  emailStreakReminder: boolean;
  /** Send an email when someone you follow publishes a new article. */
  emailFollowedArticle: boolean;
};

// ─── src/common/dto/post.dto.ts ────────────────────────────────────────────────

export type PostAuthorDto = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: VerifiedStatus;
  avatarUrl: string | null;
  orgAffiliations: Array<{ id: string; username: string | null; name: string | null; avatarUrl: string | null }>;
  isBot?: boolean;
  /** When true, author is banned; id/username/name/avatar are redacted. */
  authorBanned?: boolean;
};

export type PostMediaDto = {
  id: string;
  kind: PostMediaKind;
  source: PostMediaSource;
  url: string;
  mp4Url: string | null;
  /** Video poster image URL (from thumbnailR2Key). */
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  /** Video duration in seconds. */
  durationSeconds: number | null;
  /** Optional alt text for accessibility. */
  alt: string | null;
  // When present, the media was hard-deleted from storage and should render as a placeholder.
  deletedAt: string | null;
};

export type PostMentionDto = {
  id: string;
  username: string;
  verifiedStatus?: VerifiedStatus;
  premium?: boolean;
  premiumPlus?: boolean;
  isOrganization?: boolean;
  stewardBadgeEnabled?: boolean;
};

export type PostPollOptionDto = {
  id: string;
  text: string;
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  alt: string | null;
  voteCount: number;
  percent: number;
};

export type PostPollDto = {
  id: string;
  endsAt: string;
  ended: boolean;
  totalVoteCount: number;
  viewerHasVoted: boolean;
  viewerVotedOptionId: string | null;
  options: PostPollOptionDto[];
};

export type PostDto = {
  id: string;
  createdAt: string;
  editedAt: string | null;
  editCount: number;
  body: string;
  deletedAt: string | null;
  kind: 'regular' | 'checkin' | 'repost' | 'articleShare';
  checkinDayKey: string | null;
  checkinPrompt: string | null;
  visibility: PostVisibility;
  isDraft: boolean;
  topics: string[];
  /** User-created hashtags parsed from body text (lowercase, without '#'). */
  hashtags: string[];
  boostCount: number;
  bookmarkCount: number;
  commentCount: number;
  /** Denormalized count of flat reposts + quote reposts referencing this post. */
  repostCount: number;
  viewerCount: number;
  parentId: string | null;
  /** When set, post lives in a community group (not shown on global feeds). */
  communityGroupId: string | null;
  /** Set when this root post is pinned in its community group. */
  pinnedInGroupAt?: string | null;
  /** When viewer cannot read a group post, shell data to render a join CTA. */
  groupPreview?: CommunityGroupPreviewDto | null;
  /** When present, this post is a reply and the parent is included for thread display. */
  parent?: PostDto;
  mentions: PostMentionDto[];
  media: PostMediaDto[];
  poll?: PostPollDto | null;
  viewerHasBoosted?: boolean;
  viewerHasBookmarked?: boolean;
  viewerBookmarkCollectionIds?: string[];
  /** True if the viewer has created a flat repost of this post. */
  viewerHasReposted?: boolean;
  /** Set when a block exists between viewer and author. 'viewer_blocked' = viewer blocked the author; 'viewer_blocked_by' = author blocked the viewer. */
  viewerBlockStatus?: 'viewer_blocked' | 'viewer_blocked_by' | null;
  /** For kind='repost': the original post being reshared. */
  repostedPost?: PostDto;
  /** For posts containing an embedded post link: the quoted post (preloaded). */
  quotedPost?: PostDto;
  /** For kind='articleShare': the shared article preview. */
  article?: ArticleSharePreviewDto;
  internal?: {
    boostScore: number | null;
    boostScoreUpdatedAt: string | null;
    /** Overall popularity score (boost + bookmark + comments, time-decayed). Admin only, from popular feed. */
    score?: number | null;
  };
  author: PostAuthorDto;
  /** When true, post body/media/mentions/poll are redacted and author is placeholder. */
  authorBanned?: boolean;
  /** False when the viewer's tier does not grant access to this post (preview-only; body/media stripped). */
  viewerCanAccess?: boolean;
  /**
   * When set, this many other trending/new items from the same root thread were
   * collapsed by the API and are not shown in the feed. Used by the client to
   * render an accurate "View N more trending replies" footer.
   */
  threadCollapsedCount?: number;
};

// ─── src/common/dto/presence.dto.ts ────────────────────────────────────────────

export type UserStatusDto = {
  userId: string;
  text: string;
  setAt: string;
  expiresAt: string;
};

export type OnlineUserDto = UserListDto & {
  lastConnectAt: number | null;
  idle: boolean;
  status?: UserStatusDto | null;
  /**
   * True when this row is a synthetic bot pin (Marv) rather than a real Redis-tracked
   * online user. Frontend uses this to sort bots to the top of the list and decorate
   * the row with a small "bot" badge.
   */
  isBot?: boolean;
};

export type RecentlyOnlineUserDto = UserListDto & {
  // Presence "recently online" is always rendered as a follow-list row, so relationship is always present.
  relationship: NonNullable<UserListDto['relationship']>;
  lastOnlineAt: string | null;
  status?: UserStatusDto | null;
};

export type RecentlyOnlinePaginationDto = {
  nextCursor: string | null;
};

export type PresenceOnlinePageDto = {
  online: OnlineUserDto[];
  recent: RecentlyOnlineUserDto[];
};

export type PresenceOnlinePagePaginationDto = {
  totalOnline: number;
  recentNextCursor: string | null;
};

// ─── src/common/dto/radio.dto.ts ───────────────────────────────────────────────

export type RadioStationDto = {
  id: string;
  name: string;
  streamUrl: string;
  attributionName: string | null;
  attributionUrl: string | null;
};

export type RadioListenerDto = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
  paused?: boolean;
  muted?: boolean;
};

/**
 * Realtime lobby counts for all configured stations.
 * Keys are station IDs (e.g. "groovesalad"); values are the number of users currently in that station's lobby.
 */
export type RadioLobbyCountsDto = {
  countsByStationId: Record<string, number>;
};

export type RadioChatSenderDto = {
  id: string;
  username: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
  stewardBadgeEnabled: boolean;
};

export type RadioChatMessageDto = {
  id: string;
  stationId: string;
  body: string;
  createdAt: string; // ISO
  sender: RadioChatSenderDto;
};

export type RadioChatSnapshotDto = {
  stationId: string;
  messages: RadioChatMessageDto[];
};

// ─── src/common/dto/realtime.dto.ts ────────────────────────────────────────────

/**
 * Websocket (Socket.IO) payload DTOs.
 *
 * These are shared contracts between:
 * - `menofhunger-api` realtime emitters (PresenceRealtimeService / PresenceGateway)
 * - `menofhunger-www` socket listeners (usePresence)
 */

export type NotificationsNewPayloadDto = {
  notification: NotificationDto;
};

export type NotificationsDeletedPayloadDto = {
  notificationIds: string[];
};

/**
 * Cross-device/tab sync for message read state.
 * (We currently emit to the reader's own sockets only.)
 */
export type MessagesReadPayloadDto = {
  conversationId: string;
  userId: string;
  lastReadAt: string; // ISO
};

/** Follow/unfollow changes (currently emitted to actor's own sockets only). */
export type FollowsChangedPayloadDto = {
  actorUserId: string;
  targetUserId: string;
  viewerFollowsUser: boolean;
};

export type PostInteractionKind = 'boost' | 'bookmark';

/** Post interaction updates (currently emitted to post author + actor). */
export type PostsInteractionPayloadDto = {
  postId: string;
  actorUserId: string;
  kind: PostInteractionKind;
  active: boolean;
  boostCount?: number;
  bookmarkCount?: number;
};

export type AdminUpdateKind = 'reports' | 'verification' | 'feedback';

export type AdminUpdateAction = 'created' | 'updated' | 'deleted' | 'resolved' | 'reviewed' | 'other';

/** Admin screen change hint for cross-tab sync (emitted to the acting admin's sockets). */
export type AdminUpdatedPayloadDto = {
  kind: AdminUpdateKind;
  action: AdminUpdateAction;
  id?: string;
};

/** Public profile payload (same shape as GET /users/:username). */
export type PublicProfileDto = {
  id: string;
  createdAt: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  website: string | null;
  locationDisplay: string | null;
  locationZip: string | null;
  locationCity: string | null;
  locationCounty: string | null;
  locationState: string | null;
  locationCountry: string | null;
  /** Birthday display string honoring the user's visibility setting. */
  birthdayDisplay: string | null;
  /** Month/day only (no year), e.g. "Jan 4". Null when unset. */
  birthdayMonthDay: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: VerifiedStatus;
  avatarUrl: string | null;
  bannerUrl: string | null;
  pinnedPostId: string | null;
  lastOnlineAt: string | null;
  checkinStreakDays: number;
  longestStreakDays: number;
  /** True when this user is an active member of any Crew. */
  inCrew?: boolean;
  isBot?: boolean;
};

/**
 * Public-profile updates (emitted to the user and their followers/related users).
 * Note: name says \"selfUpdated\" for backwards compatibility with initial plan; payload is public.
 */
export type UsersSelfUpdatedPayloadDto = {
  user: PublicProfileDto;
};

/**
 * Self-only auth/settings updates (emitted to the user's own sockets only).
 * Canonical payload matches `/auth/me` user shape.
 */
export type UsersMeUpdatedPayloadDto = {
  user: UserDto;
  /** Optional hint for debugging/UI refresh decisions. */
  reason?: string;
};

/**
 * Realtime message create (already emitted today, but typed here for completeness).
 * This remains `unknown` in the gateway; callers use `toMessageDto`.
 */
export type MessagesNewPayloadDto = {
  conversationId: string;
  message: MessageDto;
};

/** Emitted to subscribers of a user when that user joins or leaves a space. */
export type UsersSpaceChangedPayloadDto = {
  userId: string;
  spaceId: string | null;
  previousSpaceId?: string;
};

export type PresenceStatusUpdatedPayloadDto = {
  status: UserStatusDto;
};

export type PresenceStatusClearedPayloadDto = {
  userId: string;
};

export type PostsSubscribePayloadDto = {
  postIds: string[];
};

export type PostsSubscribedPayloadDto = {
  postIds: string[];
};

/**
 * Minimal post patch for live updates.
 * NOTE: Keep this intentionally small; clients should treat unknown fields as best-effort.
 *
 * `posts:liveUpdated` is emitted to the `post:{id}` room, so every viewer
 * subscribed to the post sees count/body/delete updates in real time. This is
 * the correct channel for any change a third-party viewer needs to see; the
 * narrower `posts:interaction` event is reserved for actor + post author
 * (so they can reconcile their own viewerHas* flags).
 */
export type PostsLiveUpdatedPayloadDto = {
  postId: string;
  /** Monotonic-ish version (ISO timestamp string). Used for client-side stale checks. */
  version: string;
  reason: string;
  patch: Partial<{
    body: string;
    editedAt: string | null;
    editCount: number;
    deletedAt: string | null;
    commentCount: number;
    viewerCount: number;
    boostCount: number;
    bookmarkCount: number;
    repostCount: number;
  }>;
};

/** Client → server: subscribe to live updates for one or more community-group feeds. */
export type GroupsSubscribePayloadDto = {
  groupIds: string[];
};

/** Server → client ack listing the group ids the socket was actually subscribed to. */
export type GroupsSubscribedPayloadDto = {
  groupIds: string[];
};

/**
 * New top-level post (or flat repost) created inside a community group.
 * Emitted to the `group:{groupId}` room so members viewing the group feed can prepend
 * it in real time. Payload mirrors the HTTP feed shape (`PostDto`) so the client can
 * splice it into its in-memory list without a refetch.
 */
export type GroupNewPostPayloadDto = {
  groupId: string;
  post: PostDto;
};

export type ArticlesSubscribePayloadDto = {
  articleIds: string[];
};

export type ArticlesSubscribedPayloadDto = {
  articleIds: string[];
};

/**
 * Minimal article patch for live updates.
 * NOTE: Keep this intentionally small; clients should treat unknown fields as best-effort.
 */
export type ArticlesLiveUpdatedPayloadDto = {
  articleId: string;
  /** Monotonic-ish version (ISO timestamp string). Used for client-side stale checks. */
  version: string;
  reason: string;
  patch: Partial<{
    commentCount: number;
    viewCount: number;
    boostCount: number;
    reactions: ArticleReactionSummaryDto[];
  }>;
};

export type ArticlesCommentAddedPayloadDto = {
  articleId: string;
  comment: ArticleCommentDto;
};

export type ArticlesCommentDeletedPayloadDto = {
  articleId: string;
  commentId: string;
  parentId: string | null;
};

export type ArticlesCommentUpdatedPayloadDto = {
  articleId: string;
  comment: ArticleCommentDto;
};

export type ArticlesCommentReactionChangedPayloadDto = {
  articleId: string;
  commentId: string;
  parentId: string | null;
  reactions: ArticleReactionSummaryDto[];
};

/** Full reply DTO pushed to `post:{parentPostId}` room subscribers when a new reply is created. */
export type PostsCommentAddedPayloadDto = {
  parentPostId: string;
  comment: PostDto;
};

/**
 * New top-level post from someone the viewer follows.
 * Emitted to each eligible follower's `user:{followerId}` room so their home feed can
 * prepend the post in real time without polling.
 */
export type FeedNewPostPayloadDto = {
  post: PostDto;
};

/** Minimal delete hint pushed to `post:{parentPostId}` room subscribers when a reply is soft-deleted. */
export type PostsCommentDeletedPayloadDto = {
  parentPostId: string;
  commentId: string;
};

/**
 * Live "someone is replying to this post" indicator.
 * Emitted to `post:{postId}` room subscribers (excluding the sender) while a user is composing a reply.
 * Mirrors the shape of `messages:typing` / `spaces:typing` — no state persisted server-side.
 *
 * `status` is only set by server-side emitters (e.g. Marvin):
 *   - `'thinking'` — AI is processing (show purple "thinking" label)
 *   - `'replying'` — about to post the reply (show standard wave animation)
 */
export type PostsTypingPayloadDto = {
  postId: string;
  user: {
    id: string;
    username: string | null;
    verifiedStatus: string | null;
    premium: boolean;
    premiumPlus: boolean;
    isOrganization: boolean;
  };
  typing: boolean;
  status?: 'thinking' | 'replying';
};

/**
 * Crew streak realtime payloads (Phase 3 — DAU loop).
 *
 * Both events are fanned out to every member of the crew. Receivers use them to
 * celebrate the advance in-place or learn who broke the streak (the latter is
 * intentionally specific — generic "streak broke" without names is cheap to
 * ignore; named accountability is the behavioral nudge).
 */
export type CrewStreakAdvancedPayloadDto = {
  crewId: string;
  /** ET YYYY-MM-DD on which all members locked in. */
  dayKey: string;
  currentStreakDays: number;
  longestStreakDays: number;
};

export type CrewStreakBrokenPayloadDto = {
  crewId: string;
  /** ET YYYY-MM-DD that was missed (i.e. yesterday at the moment the cron ran). */
  missedDayKey: string;
  /** Member identities who failed to check in on missedDayKey. */
  missedMembers: Array<{
    id: string;
    username: string | null;
    displayName: string | null;
  }>;
};

/**
 * Live "someone in your circle just answered today's question" event.
 * Emitted to the actor's followers + crew members when a `kind: 'checkin'` post is created.
 * Carries the actor identity (so receivers can prepend a face) and the new global total.
 */
export type CheckinAnsweredTodayPayloadDto = {
  dayKey: string;
  totalToday: number;
  answerer: {
    id: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    isFollowed?: boolean;
  };
};

/** Referral recruit updated (emitted to the recruiter when a recruit reaches a milestone). */
export type ReferralRecruitUpdatedPayloadDto = {
  recruit: RecruitDto;
};

// ─── src/common/dto/referral.dto.ts ────────────────────────────────────────────

export type RecruitDto = {
  // Full user identity fields (mirrors UserListDto so the web can render UserRow)
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
  avatarUrl: string | null;
  orgAffiliations: Array<{ id: string; username: string | null; name: string | null; avatarUrl: string | null }>;
  // Referral-specific fields
  recruitedAt: string;
  /** @deprecated use verifiedStatus !== 'none' */
  isVerified: boolean;
  isPremium: boolean;
  bonusGranted: boolean;
};

export type ReferralMeDto = {
  referralCode: string | null;
  recruiter: { username: string | null; name: string | null } | null;
  recruitCount: number;
  referralBonusGranted: boolean;
};

export type AdminReferralInfoDto = {
  referralCode: string | null;
  bonusGrantedAt: string | null;
  recruiter: { id: string; username: string | null; name: string | null } | null;
  recruits: RecruitDto[];
};

export type AdminReferralAnalyticsDto = {
  totalCodesCreated: number;
  totalRecruits: number;
  totalBonusesGranted: number;
  /** Percentage of recruits who have converted to premium (0–100, integer). */
  conversionRatePct: number;
  recruitsOverTime: Array<{ bucket: string; count: number }>;
  topRecruiters: Array<{ userId: string; username: string | null; name: string | null; recruitCount: number }>;
};

// ─── src/common/dto/report.dto.ts ──────────────────────────────────────────────

export type ReportDto = {
  id: string;
  createdAt: string;
  updatedAt: string;
  targetType: ReportTargetType;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  subjectUserId: string | null;
  subjectPostId: string | null;
};

export type ReportAdminDto = ReportDto & {
  adminNote: string | null;
  resolvedAt: string | null;
  reporter: {
    id: string;
    username: string | null;
    name: string | null;
  };
  subjectUser: {
    id: string;
    username: string | null;
    name: string | null;
  } | null;
  subjectPost: {
    id: string;
    createdAt: string;
    body: string;
    deletedAt: string | null;
    user: {
      id: string;
      username: string | null;
      name: string | null;
    };
  } | null;
  resolvedByAdmin: {
    id: string;
    username: string | null;
    name: string | null;
  } | null;
};

// ─── src/common/dto/spaces.dto.ts ──────────────────────────────────────────────

export type SpaceOwnerDto = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
};

export type SpaceDto = {
  id: string;
  title: string;
  description: string | null;
  isActive: boolean;
  mode: 'NONE' | 'WATCH_PARTY' | 'RADIO';
  watchPartyUrl: string | null;
  radioStreamUrl: string | null;
  owner: SpaceOwnerDto;
  listenerCount: number;
};

export type SpaceListenerDto = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
  paused?: boolean;
  muted?: boolean;
};

export type SpaceLobbyCountsDto = {
  countsBySpaceId: Record<string, number>;
};

export type SpaceChatSenderDto = {
  id: string;
  username: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
  stewardBadgeEnabled: boolean;
};

export type SpaceChatMediaItemDto = {
  url: string;
  width: number | null;
  height: number | null;
  alt: string | null;
};

export type SpaceChatMessageDto =
  | {
      id: string;
      spaceId: string;
      kind: 'user';
      body: string;
      media?: SpaceChatMediaItemDto[];
      createdAt: string; // ISO
      sender: SpaceChatSenderDto;
    }
  | {
      id: string;
      spaceId: string;
      kind: 'system';
      system: {
        firstEvent: 'join' | 'leave';
        lastEvent: 'join' | 'leave';
        userId: string;
        username: string | null;
      };
      body: string;
      createdAt: string; // ISO
      sender: null;
    };

export type SpaceChatSnapshotDto = {
  spaceId: string;
  messages: SpaceChatMessageDto[];
};

export type SpaceReactionDto = {
  id: string;
  emoji: string;
  label: string;
};

export type SpaceReactionEventDto = {
  spaceId: string;
  userId: string;
  reactionId: string;
  emoji: string;
};

export type WatchPartyStateDto = {
  videoUrl: string;
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
  updatedAt: number;
};

export type SpaceModeChangedDto = {
  spaceId: string;
  mode: 'NONE' | 'WATCH_PARTY' | 'RADIO';
  watchPartyUrl: string | null;
  radioStreamUrl: string | null;
};

// ─── src/common/dto/topic.dto.ts ───────────────────────────────────────────────

export type TopicDto = {
  /** Normalized topic string (lowercase, spaces). Safe to URL-encode and use as route param. */
  topic: string;
  /** Canonical category key (lowercase). */
  category: string;
  /** Human-friendly category label (e.g. "Technology"). */
  categoryLabel: string;
  /** Composite score used for ranking only. */
  score: number;
  /** How many times this topic appeared in users' interests. */
  interestCount: number;
  /** How many times this topic appeared in recent post text. */
  postCount: number;
  /** When viewer is authenticated, whether they follow this topic. */
  viewerFollows?: boolean;
};

export type TopicCategoryDto = {
  /** Canonical category key (lowercase). */
  category: string;
  /** Human-friendly label (e.g. "Technology"). */
  label: string;
  /** Composite score used for ranking only. */
  score: number;
  /** Sum of interestCount across topics in this category. */
  interestCount: number;
  /** Sum of postCount across topics in this category. */
  postCount: number;
};

// ─── src/common/dto/user.dto.ts ────────────────────────────────────────────────

/** Minimal org account summary shown alongside affiliated users. */
export type OrgAffiliationDto = {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
};

/** Relationship fields for list-user DTOs (follows, search). */
export type UserListRelationship = {
  viewerFollowsUser: boolean;
  userFollowsViewer: boolean;
  /** True when the viewer has enabled “every post” notifications (bell icon) for this follow. */
  viewerPostNotificationsEnabled: boolean;
};

export type NudgeStateDto = {
  /**
   * True when the viewer is currently blocked from nudging this user.
   *
   * Blocked when the viewer has nudged this user within the last 24h and neither:
   * - the other user nudged back, nor
   * - the other user acknowledged it via “Got it” (readAt set without ignoredAt).
   *
   * Note: “Ignore” does NOT clear the block (ignoredAt is persisted to keep the sender rate-limited).
   */
  outboundPending: boolean;
  /** True when this user has an unread inbound nudge to the viewer (within the expiry window). */
  inboundPending: boolean;
  /** Latest unread inbound nudge notification ID (for “Got it” / acknowledge, or “Nudge back”). */
  inboundNotificationId: string | null;
  /** When the outbound nudge block expires (ISO string), if any. */
  outboundExpiresAt: string | null;
};

/** List-user DTO (follow lists, search users). Optional relationship and createdAt. */
export type UserListDto = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: VerifiedStatus;
  avatarUrl: string | null;
  orgAffiliations: OrgAffiliationDto[];
  relationship?: UserListRelationship;
  createdAt?: string;
  isBot?: boolean;
};

export type UserDto = {
  id: string;
  createdAt: string;
  phone: string;
  email: string | null;
  emailVerifiedAt: string | null;
  emailVerificationRequestedAt: string | null;
  username: string | null;
  usernameIsSet: boolean;
  name: string | null;
  bio: string | null;
  website: string | null;
  locationInput: string | null;
  locationDisplay: string | null;
  locationZip: string | null;
  locationCity: string | null;
  locationCounty: string | null;
  locationState: string | null;
  locationCountry: string | null;
  birthdate: string | null;
  interests: string[];
  menOnlyConfirmed: boolean;
  siteAdmin: boolean;
  featureToggles: AppFeatureToggle[];
  bannedAt: string | null;
  bannedReason: string | null;
  bannedByAdminId: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: VerifiedStatus;
  verifiedAt: string | null;
  unverifiedAt: string | null;
  followVisibility: FollowVisibility;
  birthdayVisibility: BirthdayVisibility;
  avatarUrl: string | null;
  bannerUrl: string | null;
  pinnedPostId: string | null;
  // Private rewards (self-only surfaces).
  coins: number;
  checkinStreakDays: number;
  lastCheckinDayKey: string | null;
  longestStreakDays: number;
  locationPromptSkipped: boolean;
  /** True when the user has opted in to the crew-discovery directory. */
  openToCrew: boolean;
};

export type AdminUserSensitiveFieldsDto = {
  phone: string;
  email: string | null;
  birthdate: string | null;
};

export type AdminUserDetailDto = UserDto & {
  sensitive: AdminUserSensitiveFieldsDto;
  canRevealSensitive: boolean;
};

export type AdminUserRecentPostDto = {
  id: string;
  createdAt: string;
  body: string;
  parentId: string | null;
  rootId: string | null;
  kind: string;
  visibility: string;
  commentCount: number;
  boostCount: number;
  bookmarkCount: number;
};

export type AdminUserRecentArticleDto = {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  createdAt: string;
  publishedAt: string | null;
  isDraft: boolean;
  visibility: string;
  viewCount: number;
  boostCount: number;
  commentCount: number;
};

export type AdminUserRecentSearchDto = {
  id: string;
  query: string;
  createdAt: string;
};

export type UserPreviewDto = {
  id: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  lastOnlineAt: string | null;
  relationship: UserListRelationship;
  nudge: NudgeStateDto | null;
  followerCount: number | null;
  followingCount: number | null;
};

// ─── src/common/dto/verification-request.dto.ts ────────────────────────────────

export type VerificationRequestPublicDto = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: VerificationRequestStatus;
  provider: string | null;
  providerRequestId: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
};

export type VerificationRequestAdminUserSummaryDto = {
  id: string;
  createdAt: string;
  phone: string;
  email: string | null;
  username: string | null;
  usernameIsSet: boolean;
  name: string | null;
  siteAdmin: boolean;
  premium: boolean;
  premiumPlus: boolean;
  verifiedStatus: VerifiedStatus;
  verifiedAt: string | null;
  unverifiedAt: string | null;
};

export type VerificationRequestAdminDto = VerificationRequestPublicDto & {
  user: VerificationRequestAdminUserSummaryDto;
  reviewedByAdmin: { id: string; username: string | null; name: string | null } | null;
  adminNote: string | null;
};

// ─── src/common/dto/websters1828.dto.ts ────────────────────────────────────────

export type Websters1828WordOfDayDto = {
  word: string;
  dictionaryUrl: string;
  definition: string | null;
  definitionHtml: string | null;
  sourceUrl: string;
  fetchedAt: string;
};

// ─── src/modules/messages/message.dto.ts ───────────────────────────────────────

export type MessageParticipantDto = {
  user: UserListDto;
  status: MessageParticipantStatus;
  role: MessageParticipantRole;
  acceptedAt: string | null;
  lastReadAt: string | null;
  banned: boolean;
};

export type MessageReactionSummaryDto = {
  reactionId: string;
  emoji: string;
  count: number;
  reactedByMe: boolean;
  reactors: { id: string; username: string | null; avatarUrl: string | null }[];
};

export type MessageReplySnippetDto = {
  id: string;
  senderUsername: string | null;
  bodyPreview: string;
  /** Thumbnail URL of the first media item on the replied-to message, if any. */
  mediaThumbnailUrl: string | null;
};

export type MessageMediaDto = {
  id: string;
  kind: 'image' | 'gif' | 'video';
  source: 'upload' | 'giphy';
  url: string;
  mp4Url: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  alt: string | null;
};

export type MessageDto = {
  id: string;
  createdAt: string;
  body: string;
  conversationId: string;
  sender: UserListDto;
  reactions: MessageReactionSummaryDto[];
  deletedForMe: boolean;
  /** True when the sender deleted this message for all participants. */
  deletedForAll: boolean;
  /** ISO string of when the message was last edited, or null. */
  editedAt: string | null;
  replyTo: MessageReplySnippetDto | null;
  media: MessageMediaDto[];
};

/**
 * Lightweight crew summary attached to `crew_wall` conversations so the chat list
 * can render the crew avatar, label the row as a Crew chat, and link to /c/:slug
 * without an extra round-trip per row.
 */
export type MessageConversationCrewSummaryDto = {
  id: string;
  slug: string;
  /** Display name; null when the crew hasn't been named yet. */
  name: string | null;
  avatarUrl: string | null;
};

export type MessageConversationDto = {
  id: string;
  type: 'direct' | 'group' | 'crew_wall';
  title: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  lastMessage: { id: string; body: string; createdAt: string; senderId: string } | null;
  participants: MessageParticipantDto[];
  viewerStatus: MessageParticipantStatus;
  unreadCount: number;
  /** True when the viewer has muted notifications for this conversation. */
  isMuted: boolean;
  /** True when a block exists in either direction between the viewer and the other participant (direct chats only). */
  isBlockedWith?: boolean;
  /** Present on search results when a message body matched (not a name/title match). */
  matchedMessage?: { id: string; body: string; createdAt: string } | null;
  /**
   * Populated only for `crew_wall` conversations. Lets the chat row render the
   * crew avatar/name and link to the crew's public page.
   */
  crew?: MessageConversationCrewSummaryDto | null;
};

// ─── src/modules/notifications/notification.dto.ts ─────────────────────────────

export type NotificationActorDto = {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  premium: boolean;
  isOrganization: boolean;
  verifiedStatus: VerifiedStatus;
};

/** Preview of the subject post (e.g. boosted post) for display in the notification row. */
export type SubjectPostPreviewDto = {
  bodySnippet: string | null;
  media: Array<{ url: string; thumbnailUrl: string | null; kind: string }>;
};

/** Preview of the subject article for display in the notification row. */
export type SubjectArticlePreviewDto = {
  title: string | null;
  excerpt: string | null;
  thumbnailUrl: string | null;
  visibility: string | null;
};

export type SubjectPostVisibility = 'public' | 'verifiedOnly' | 'premiumOnly' | 'onlyMe';

/** Tier of the notification subject (post visibility or user tier) for unseen row highlight. */
export type SubjectTier = 'premium' | 'verified' | null;

export type NotificationDto = {
  id: string;
  createdAt: string;
  kind: NotificationKind;
  deliveredAt: string | null;
  readAt: string | null;
  ignoredAt: string | null;
  nudgedBackAt: string | null;
  actor: NotificationActorDto | null;
  /** The post that caused this notification (e.g. a reply or mention post). */
  actorPostId: string | null;
  subjectPostId: string | null;
  subjectUserId: string | null;
  subjectArticleId: string | null;
  subjectArticleCommentId: string | null;
  subjectGroupId: string | null;
  /** Slug of the subject group (only populated for group_join_request notifications). */
  subjectGroupSlug: string | null;
  /** Display name of the subject group (only populated for group_join_request notifications). */
  subjectGroupName: string | null;
  /** Crew this notification is about (set for any crew_* kind that has a real crew). */
  subjectCrewId: string | null;
  /**
   * Specific crew invite this notification refers to (crew_invite_received and related).
   * Lets the notification UI accept/decline the exact invite directly.
   */
  subjectCrewInviteId: string | null;
  /**
   * Current lifecycle status of `subjectCrewInviteId`, when present. Used so the
   * notification row can render the correct terminal state ("Joined crew",
   * "Declined", "No longer available") on a fresh load — without the FE having
   * to call /crew/invites/inbox just to figure out whether the invite is still
   * actionable.
   */
  subjectCrewInviteStatus: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | null;
  /**
   * Display name for the crew this notification refers to, if known. For founding
   * invites (no crew yet) this falls back to the inviter's chosen
   * `CrewInvite.crewNameOnAccept`. Null when neither is set — the FE should render
   * "their crew" in that case.
   */
  subjectCrewName: string | null;
  /**
   * Specific community-group invite this notification refers to (set for
   * `community_group_invite_*` kinds). Lets the row accept/decline directly.
   */
  subjectCommunityGroupInviteId: string | null;
  /**
   * Current lifecycle status of `subjectCommunityGroupInviteId`, when present.
   * Mirrors `subjectCrewInviteStatus` so the UI can render the correct terminal
   * state ("Joined", "Declined", "No longer available") on a fresh load.
   */
  subjectCommunityGroupInviteStatus:
    | 'pending'
    | 'accepted'
    | 'declined'
    | 'cancelled'
    | 'expired'
    | null;
  /** Conversation this notification is about (used for `message` kind). */
  subjectConversationId: string | null;
  title: string | null;
  body: string | null;
  /** When set (e.g. boost), for quote + stacked images / video thumbnail in the UI. */
  subjectPostPreview?: SubjectPostPreviewDto | null;
  /** Full post row payload for notifications that should render as a post. */
  post?: PostDto | null;
  /** When subject is an article (followed_article), article card preview. */
  subjectArticlePreview?: SubjectArticlePreviewDto | null;
  /** When subject is a post, its visibility (used for UI tinting). */
  subjectPostVisibility?: SubjectPostVisibility | null;
  /** Tier of subject (post or user) for unseen row highlight. */
  subjectTier: SubjectTier;
};

// ─── src/common/feature-toggles.ts ─────────────────────────────────────────────

export type AppFeatureToggle = never;
