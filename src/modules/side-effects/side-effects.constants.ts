import type { NotificationKind, PostVisibility } from '@prisma/client';

/**
 * Dedicated BullMQ queue for post-commit side effects (notifications, push, fan-out).
 *
 * These get their own queue — separate from the cron-heavy `moh_background` queue — for the
 * same reason Marv does: a user waiting on a reply notification must never queue behind a
 * multi-minute hashtag-cleanup or weekly-digest sweep. Concurrency is tuned independently
 * via `SIDE_EFFECTS_QUEUE_CONCURRENCY` (default 12).
 */
export const MOH_SIDE_EFFECTS_QUEUE = 'moh_side_effects';

/**
 * Every side effect the app can dispatch, mapped to its payload shape.
 *
 * Payload rules (these exist because a job may be retried minutes after the mutation):
 *   1. **IDs and primitives only.** Payloads are JSON-serialized into Redis, so no `Map`,
 *      `Set`, `Date`, or Prisma model instances.
 *   2. **No snapshots of mutable state.** Handlers re-read what they need from Postgres so a
 *      retry acts on current state rather than a stale copy.
 *
 * Adding a side effect means adding an entry here and registering a handler — no processor
 * or switch statement to update.
 */
export interface SideEffectPayloads {
  // ─── Posts ────────────────────────────────────────────────────────────
  'post.created': {
    postId: string;
    actorUserId: string;
    didAwardStreak: boolean;
    requestedMarvMode: 'fast' | 'regular' | 'smart' | null;
  };
  'post.deleted': {
    postId: string;
  };
  /**
   * A boost or repost was added or removed. One event covers all four because the handler's
   * job is identical: reconcile the author's notification with whether the engagement still
   * exists. `active: false` means "remove the notification".
   */
  'post.engagement.changed': {
    kind: 'boost' | 'repost';
    active: boolean;
    postId: string;
    recipientUserId: string;
    actorUserId: string;
    /** The repost row's id, for `kind: 'repost'` with `active: true`. */
    actorPostId?: string | null;
  };

  /**
   * The quoted post link inside an existing post was added, removed, or swapped.
   * The side-effects worker adjusts the post's `quotedPost` notification on the new
   * target (if any) and deletes the notification on the old target (if any).
   */
  'post.quote.changed': {
    /** The post whose body was edited. */
    postId: string;
    actorUserId: string;
    /** The previously-quoted post's id (null when the edit *added* the first quote). */
    prevQuotedPostId: string | null;
    /** The newly-quoted post's id (null when the edit *removed* the last quote). */
    nextQuotedPostId: string | null;
  };

  // ─── Articles ─────────────────────────────────────────────────────────
  'article.published': {
    articleId: string;
    authorUserId: string;
  };
  'article.comment.created': {
    articleId: string;
    commentId: string;
    actorUserId: string;
    parentCommentId: string | null;
    mentionUsernames: string[];
  };
  'article.boosted': {
    articleId: string;
    actorUserId: string;
  };
  'article.reaction.added': {
    articleId: string;
    actorUserId: string;
    emoji: string;
  };
  // ─── Notifications ────────────────────────────────────────────────────
  /**
   * Deliver push (APNs + Web Push) for an already-written notification row.
   *
   * Mirrors `NotificationPushService.sendKindPushForActor` params. This is the
   * highest-traffic effect in the app — every one of the 40+ notification kinds funnels
   * through it — and putting it on the queue is what buys retries for the network calls
   * (APNs, VAPID) that actually fail. Retries are safe because `pushCoalesce` suppresses a
   * duplicate send for the same tag inside the kind's coalesce window.
   */
  'notification.push': {
    recipientUserId: string;
    kind: NotificationKind;
    actorUserId: string | null;
    fallbackTitle?: string | null;
    body?: string | null;
    actorPostId?: string | null;
    subjectArticleId?: string | null;
    subjectPostId?: string | null;
    subjectUserId?: string | null;
    subjectGroupId?: string | null;
    subjectCommunityGroupInviteId?: string | null;
    url?: string | null;
    notificationId?: string | null;
    sourceLabel?: string;
  };
  /**
   * Debounced badge-only APNs sync after bell/groups undelivered counts change.
   * Optional hints let the worker skip a recompute when both are known and unchanged.
   */
  'notification.badge.sync': {
    recipientUserId: string;
    undeliveredBellCount?: number;
    undeliveredGroupsCount?: number;
  };
  /**
   * Drop lock-screen APNs the user already saw in-app (inbox vs groups section).
   * Separate from badge sync so debounce cannot swallow the clear.
   */
  'notification.lockScreen.clear': {
    recipientUserId: string;
    section: 'inbox' | 'groups';
  };
  /**
   * Patch switcher badges across an operator's identity cluster after bell, groups,
   * or chat unread changes. Handler re-reads the count. No-op when the user has no pages.
   */
  'account.cluster.badge': {
    userId: string;
  };
  /**
   * One chunk of a large notification fan-out. Large recipient sets are split into child
   * jobs so a single job never holds the worker (or the Prisma pool) for minutes.
   */
  'notification.fanout.chunk': {
    kind: 'followed_post' | 'checkin_post' | 'followed_article' | 'community_group_post';
    recipientUserIds: string[];
    actorUserId: string;
    actorPostId: string | null;
    subjectPostId: string | null;
    subjectUserId: string | null;
    subjectArticleId: string | null;
    subjectGroupId: string | null;
    title: string | null;
    body: string | null;
  };

  // ─── Crew ─────────────────────────────────────────────────────────────
  /** Invite row was created; notify the invitee. Handler reads the row for crew + message. */
  'crew.invite.sent': {
    inviteId: string;
  };
  /**
   * Invite left `pending`. The handler reads the row's terminal status to decide who to
   * notify, so accept/decline/cancel share one effect and a retry can't act on a stale
   * outcome.
   */
  'crew.invite.resolved': {
    inviteId: string;
  };
  'crew.member.removed': {
    crewId: string;
    actorUserId: string;
    /** The member who left or was kicked. */
    subjectUserId: string;
    reason: 'left' | 'kicked';
  };
  /**
   * Crew is gone, so its membership rows are too — the recipient list has to be carried in
   * the payload. It's a record of who *was* a member, which can't go stale.
   */
  'crew.disbanded': {
    crewId: string;
    actorUserId: string | null;
    memberUserIds: string[];
  };
  'crew.owner.transferred': {
    crewId: string;
    previousOwnerUserId: string | null;
    newOwnerUserId: string;
    reason: 'direct' | 'vote' | 'inactivity';
  };
  'crew.transfer.vote.opened': {
    crewId: string;
    voteId: string;
    actorUserId: string;
  };
  'crew.wall.mentioned': {
    crewId: string;
    actorUserId: string;
    recipientUserIds: string[];
    bodySnippet: string | null;
  };
  /**
   * The crew's shared streak advanced — the highest-signal push in the product, so it gets
   * retries rather than being a fire-and-forget send from the check-in request.
   */
  'crew.streak.advanced': {
    crewId: string;
    dayKey: string;
    currentStreakDays: number;
  };

  // ─── Community groups ─────────────────────────────────────────────────
  'group.invite.issued': {
    groupId: string;
    inviteId: string;
    inviterUserId: string;
    inviteeUserId: string;
    bodySnippet: string | null;
  };
  'group.invite.cancelled': {
    groupId: string;
    inviteId: string;
    actorUserId: string;
    inviteeUserId: string;
  };
  'group.invite.responded': {
    groupId: string;
    inviteId: string;
    inviterUserId: string;
    inviteeUserId: string;
    response: 'accepted' | 'declined';
  };
  /** Someone asked to join a gated group; notify owners + moderators. */
  'group.join.requested': {
    groupId: string;
    requestingUserId: string;
  };
  /** A moderator approved or rejected a join request. Approval also notifies members. */
  'group.join.decided': {
    groupId: string;
    userId: string;
    actorUserId: string;
    decision: 'approved' | 'rejected';
  };
  /** Someone joined an open group directly (no approval step); notify existing members. */
  'group.member.joined': {
    groupId: string;
    joinerUserId: string;
  };
  'group.member.removed': {
    groupId: string;
    userId: string;
    actorUserId: string;
  };

  // ─── Follows ──────────────────────────────────────────────────────────
  /**
   * The handler (not the caller) applies the 24h "don't re-notify" window, which also makes a
   * retry idempotent.
   */
  'follow.created': {
    actorUserId: string;
    targetUserId: string;
  };
  'follow.removed': {
    actorUserId: string;
    targetUserId: string;
  };

  // ─── Coins / verification ─────────────────────────────────────────────
  'coins.transferred': {
    recipientUserId: string;
    senderUserId: string;
    amountLabel: string;
    note: string | null;
  };
  /** A user just became verified; tell them. */
  'user.verified': {
    userId: string;
  };
  /**
   * The user's premium access boundary crossed none<->premium.
   * `direction: 'started'` when they gained any premium tier;
   * `direction: 'ended'` when they lost it entirely.
   * Premium <-> Premium+ moves are not dispatched.
   */
  'billing.premium.changed': {
    userId: string;
    direction: 'started' | 'ended';
  };
  /**
   * User just gained Premium — Marv sends a one-shot welcome DM.
   * Dispatched from the billing premium-changed handler when direction is `started`.
   */
  'marv.premium.welcome': {
    userId: string;
  };
  /**
   * Referral bonus was granted — one-time, once per recruit's first payment.
   * Handler calls syncGrantTrialToSubscription for both parties so any
   * active Stripe subscriptions defer their next charge to absorb the free month.
   * Payload uses IDs only (no mutable state snapshots).
   */
  'referral.bonus.granted': {
    recruitId: string;
    recruiterId: string;
  };
  /**
   * Evaluate the auto-verify site toggle for a new signup or a freshly-linked recruit.
   *
   * The toggle is read in the handler, not the caller, so an admin flipping it mid-flight
   * gets the current answer. `verifyUser` short-circuits when the user is already verified,
   * which is what makes this safe to retry.
   */
  'user.auto-verify': {
    userId: string;
    recruitedById: string | null;
    source: 'auto_referral' | 'auto_signup';
  };

  // ─── Spaces schedule ──────────────────────────────────────────────────
  /** Host went live — fan out `space_live` to schedule subscribers. */
  'space.schedule.live': {
    spaceId: string;
    /** Snapshot before clearing non-owner subscribers on activate. */
    recipientUserIds?: string[];
  };
  /**
   * Host ended the space (or it went idle). Quietly retitle existing `space_live`
   * rows to "was live" without bumping time, unread, or push.
   * Delete writes this inline before the Space row is removed (FK SET NULL).
   */
  'space.schedule.ended': {
    spaceId: string;
    /** Fallback title if the space row is already gone. */
    spaceTitle?: string;
  };
  /** Schedule cleared or space deleted — fan out `space_schedule_cancelled`. */
  'space.schedule.cancelled': {
    spaceId: string;
    ownerUserId: string;
    spaceTitle: string;
    ownerUsername: string | null;
    /** When set (e.g. space delete), use these IDs instead of re-reading subscribers. */
    recipientUserIds?: string[];
  };
  /** Schedule time changed — fan out cancel-style “rescheduled” copy then subscribers keep their sub. */
  'space.schedule.rescheduled': {
    spaceId: string;
    scheduledAt: string; // ISO
  };
  /** Delayed reminder job fired (day-of or 15-min). Handler re-reads DB. */
  'space.schedule.reminder': {
    spaceId: string;
    kind: 'space_reminder_day' | 'space_reminder_soon';
    scheduledAtMs: number;
  };
}

export type SideEffectName = keyof SideEffectPayloads;

/** Visibility is re-exported so payload consumers don't need a Prisma import. */
export type SideEffectVisibility = PostVisibility;

/**
 * Recipients per `notification.fanout.chunk` job. Sized so one chunk stays well under a
 * second of DB work while keeping the number of jobs small for typical accounts.
 */
export const FANOUT_CHUNK_SIZE = 200;

/**
 * Above this many recipients, a handler splits the fan-out into `notification.fanout.chunk`
 * child jobs instead of doing it inline.
 */
export const FANOUT_CHUNK_THRESHOLD = FANOUT_CHUNK_SIZE;
