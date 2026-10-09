import type { NotificationKind } from "@prisma/client";
import { type PushActorContext } from "./notification-push.constants";

export function actorDisplayName(actor?: PushActorContext | null): string {
  const name = (actor?.name ?? "").trim();
  if (name) return name;
  const username = (actor?.username ?? "").trim();
  if (username) return `@${username}`;
  return "Someone";
}

export function trimPushBody(body?: string | null, max = 140): string | null {
  const text = (body ?? "").trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function buildPushCopy(params: {
  kind: NotificationKind;
  actor?: PushActorContext | null;
  fallbackTitle?: string | null;
  body?: string | null;
  subjectArticleId?: string | null;
}): {
  title: string;
  body?: string;
} {
  const { kind, actor, fallbackTitle, body, subjectArticleId } = params;
  const actorName = actorDisplayName(actor);
  const snippet = trimPushBody(body);
  // Prefer the role-specific DB title (already encodes "post" vs "comment" / article variants)
  // when it's set, just prefixed with the actor name. This keeps push wording in lockstep
  // with what the in-app row shows.
  const titleFromFallback = (fallbackTitle ?? "").trim();
  if (kind === "comment") {
    if (titleFromFallback) {
      return {
        title: `${actorName} ${titleFromFallback}`,
        body:
          snippet ??
          (subjectArticleId
            ? "Open to view the comment."
            : "Open to view the reply."),
      };
    }
    if (subjectArticleId) {
      return {
        title: `${actorName} replied to your article`,
        body: snippet ?? "Open to view the reply.",
      };
    }
    return {
      title: `${actorName} replied to your post`,
      body: snippet ?? "Open to view the reply.",
    };
  }
  if (kind === "mention") {
    if (titleFromFallback) {
      return {
        title: `${actorName} ${titleFromFallback}`,
        body: snippet ?? "Open to view the mention.",
      };
    }
    if (subjectArticleId) {
      return {
        title: `${actorName} mentioned you in an article comment`,
        body: snippet ?? "Open to view the mention.",
      };
    }
    return {
      title: `${actorName} mentioned you`,
      body: snippet ?? "Open to view the mention.",
    };
  }
  if (kind === "follow") {
    return {
      title: `${actorName} followed you`,
      body: snippet ?? "Open their profile.",
    };
  }
  if (kind === "boost") {
    if (subjectArticleId) {
      return {
        title: `${actorName} boosted your article`,
        body: snippet ?? "Your article is getting traction.",
      };
    }
    return {
      title: titleFromFallback
        ? `${actorName} ${titleFromFallback}`
        : `${actorName} boosted your post`,
      body: snippet ?? "Your post is getting traction.",
    };
  }
  if (kind === "repost") {
    if (titleFromFallback) {
      return {
        title: `${actorName} ${titleFromFallback}`,
        body: snippet ?? "Open to view.",
      };
    }
    return {
      title: `${actorName} reposted your post`,
      body: snippet ?? "Open to view the repost.",
    };
  }
  if (kind === "followed_post") {
    return {
      title: titleFromFallback
        ? `${actorName} ${titleFromFallback}`
        : `${actorName} posted`,
      body: snippet ?? "Open to read it.",
    };
  }
  if (kind === "checkin_post") {
    return {
      title: titleFromFallback
        ? `${actorName} ${titleFromFallback}`
        : `${actorName} checked in`,
      body: snippet ?? "Open to see their check-in.",
    };
  }
  if (kind === "status_update") {
    return {
      title: `${actorName} updated their status`,
      body: snippet ?? "Open their profile to see it.",
    };
  }
  if (kind === "followed_article") {
    return {
      title: `${actorName} published an article`,
      body: snippet ?? "Open to read it.",
    };
  }
  if (kind === "nudge") {
    return {
      title: `${actorName} nudged you`,
      body: snippet ?? "Open notifications to respond.",
    };
  }
  if (kind === "poll_results_ready") {
    return {
      title: "Poll results are ready",
      body: snippet ?? "Open to see the results.",
    };
  }
  if (kind === "coin_transfer") {
    return {
      title: `${actorName} sent you coins`,
      body: snippet ?? "Open to view your coin activity.",
    };
  }
  if (kind === "group_join_request") {
    return {
      title: `${actorName} asked to join your group`,
      body: snippet ?? "Open to review the request.",
    };
  }
  if (kind === "crew_invite_received") {
    return {
      title: `${actorName} invited you to their crew`,
      body: snippet ?? "Open to see the invite.",
    };
  }
  if (kind === "crew_invite_accepted") {
    return {
      title: `${actorName} accepted your crew invite`,
      body: snippet ?? "Welcome them to the crew.",
    };
  }
  if (kind === "crew_invite_declined") {
    return {
      title: `${actorName} declined your crew invite`,
      body: snippet ?? "No worries — invite someone else.",
    };
  }
  if (kind === "crew_member_joined") {
    return {
      title: `${actorName} joined your crew`,
      body: snippet ?? "Say hello on the wall.",
    };
  }
  if (kind === "crew_member_left") {
    return {
      title: `${actorName} left your crew`,
      body: snippet ?? "Your crew roster changed.",
    };
  }
  if (kind === "crew_member_kicked") {
    return {
      title: "Crew roster changed",
      body: snippet ?? "A member was removed from your crew.",
    };
  }
  if (kind === "crew_owner_transferred") {
    return {
      title: "Crew ownership transferred",
      body: snippet ?? "Your crew has a new owner.",
    };
  }
  if (kind === "crew_owner_transfer_vote") {
    return {
      title: `${actorName} started a vote in your crew`,
      body: snippet ?? "Open to cast your vote.",
    };
  }
  if (kind === "crew_wall_mention") {
    return {
      title: `${actorName} mentioned you on the wall`,
      body: snippet ?? "Open the crew wall to reply.",
    };
  }
  if (kind === "crew_disbanded") {
    return {
      title: "Your crew was disbanded",
      body: snippet ?? "Start a new crew when you\u2019re ready.",
    };
  }
  if (kind === "crew_invite_cancelled") {
    return {
      title: "Crew invite cancelled",
      body: snippet ?? "The invite is no longer active.",
    };
  }
  if (kind === "community_group_invite_received") {
    return {
      title: `${actorName} invited you to a group`,
      body: snippet ?? "Open to see the invite.",
    };
  }
  if (kind === "community_group_invite_accepted") {
    return {
      title: `${actorName} accepted your group invite`,
      body: snippet ?? "Welcome them to the group.",
    };
  }
  if (kind === "community_group_invite_declined") {
    return {
      title: `${actorName} declined your group invite`,
      body: snippet ?? "No worries — invite someone else.",
    };
  }
  if (kind === "community_group_invite_cancelled") {
    return {
      title: "Group invite cancelled",
      body: snippet ?? "The invite is no longer active.",
    };
  }
  if (kind === "community_group_member_joined") {
    return {
      title: `${actorName} joined the group`,
      body: snippet ?? "Open to see the new member.",
    };
  }
  if (kind === "community_group_join_approved") {
    return {
      title: "Your join request was approved",
      body: snippet ?? "You\u2019re now a member.",
    };
  }
  if (kind === "community_group_join_rejected") {
    return {
      title: "Your join request was not accepted",
      body: snippet ?? "You can request to join another group.",
    };
  }
  if (kind === "community_group_member_removed") {
    return {
      title: "You were removed from a group",
      body: snippet ?? "Open to see your groups.",
    };
  }
  if (kind === "community_group_disbanded") {
    return {
      title: "A group you were in was disbanded",
      body: snippet ?? "Open to find another group.",
    };
  }
  if (kind === "message") {
    return {
      title: `${actorName} sent you a message`,
      body: snippet ?? "Open to read it.",
    };
  }
  if (kind === "checkin_reminder") {
    return {
      title: titleFromFallback || "Have you checked in today?",
      body: snippet ?? "Post your check-in to keep your streak alive.",
    };
  }
  if (kind === "on_this_day") {
    return {
      title: titleFromFallback || "On this day",
      body: snippet ?? "Open to revisit your check-in.",
    };
  }
  if (kind === "word_of_the_day") {
    return {
      title: titleFromFallback || "Good morning!",
      body: snippet ?? "Open for today\u2019s word.",
    };
  }
  if (kind === "quote_of_the_day") {
    return {
      title: titleFromFallback || "Quote of the day",
      body: snippet ?? "Open to read today\u2019s quote.",
    };
  }
  if (kind === "account_verified") {
    return {
      title: titleFromFallback || "You're verified",
      body: snippet ?? "Your account is now verified. Welcome.",
    };
  }
  if (kind === "premium_started") {
    return {
      title: titleFromFallback || "You're Premium",
      body: snippet ?? "Premium is active. Thanks for backing Men of Hunger.",
    };
  }
  if (kind === "premium_ended") {
    return {
      title: titleFromFallback || "Your Premium ended",
      body: snippet ?? "Premium access has ended. You can restart anytime.",
    };
  }
  if (kind === "space_reminder_day") {
    return {
      title: titleFromFallback || "Space today",
      body: snippet ?? "A space you asked about is scheduled for today.",
    };
  }
  if (kind === "space_reminder_soon") {
    return {
      title: titleFromFallback || "Space starting soon",
      body: snippet ?? "Starts in about 30 minutes.",
    };
  }
  if (kind === "space_live") {
    return {
      title: titleFromFallback || "Space is live",
      body: snippet ?? "Tap to join now.",
    };
  }
  if (kind === "space_schedule_cancelled") {
    return {
      title: titleFromFallback || "Space cancelled",
      body: snippet ?? "The scheduled space was cancelled.",
    };
  }
  if (kind === "space_schedule_rescheduled") {
    return {
      title: titleFromFallback || "Space rescheduled",
      body: snippet ?? "The start time changed.",
    };
  }
  if (kind === "followed_space") {
    return {
      title: titleFromFallback || "Space scheduled",
      body: snippet ?? "Someone you follow scheduled a space.",
    };
  }
  // Generic kind is used for one-off actor-driven events that don't have their own kind
  // (e.g. article emoji reactions). Prefix the DB title with the actor name when both
  // are present so the push reads like "Jane reacted to your article" with body=emoji.
  if (kind === "generic" && titleFromFallback && actor) {
    return {
      title: `${actorName} ${titleFromFallback}`,
      ...(snippet ? { body: snippet } : { body: "Open to view it." }),
    };
  }
  if (kind === "generic") {
    return {
      title: titleFromFallback || "New activity",
      body: snippet ?? "Open to view it.",
    };
  }
  // These kinds do not currently send push notifications, but explicit copy keeps a future
  // delivery path from falling back to technical or generic text.
  if (kind === "community_group_post") {
    return {
      title: titleFromFallback || "New group post",
      body: snippet ?? "Open to read it.",
    };
  }
  if (kind === "marv_not_in_group") {
    return {
      title: titleFromFallback || "Group update",
      body: snippet ?? "Open to view the update.",
    };
  }
  return {
    title: titleFromFallback || "New notification",
    ...(snippet ? { body: snippet } : { body: "You have a new notification." }),
  };
}

export function buildPushTag(params: {
  recipientUserId: string;
  kind: NotificationKind;
  actorUserId?: string | null;
  subjectPostId?: string | null;
  subjectUserId?: string | null;
}): string {
  const { recipientUserId, kind, actorUserId, subjectPostId, subjectUserId } = params;
  if (subjectPostId) return `notif-${kind}-post-${subjectPostId}`;
  if (subjectUserId) return `notif-${kind}-user-${subjectUserId}`;
  if (actorUserId) return `notif-${kind}-actor-${actorUserId}`;
  return `notif-${kind}-${recipientUserId}`;
}

export function pushCategory(kind: NotificationKind, hasReplyPost: boolean): string | null {
  if ((kind === 'comment' || kind === 'mention') && hasReplyPost) return 'moh.category.reply';
  if (kind === 'follow') return 'moh.category.follow';
  if (kind === 'community_group_invite_received') return 'moh.category.groupInvite';
  return null;
}

/**
 * iOS Communication notifications replace the title with the sender name and
 * often omit the subtitle. Fold the action into the body so lock-screen copy
 * still says what happened (e.g. "Replied to your post:\nWash sheets…").
 * DMs stay message-style (name + body only).
 */
export function apnsBodyWithVisibleAction(params: {
  kind: string;
  body: string;
  subtitle?: string | null;
  actorUsername?: string | null;
}): string {
  const snippet = (params.body ?? '').trim();
  if (!params.actorUsername || params.kind === 'message') return snippet;
  const action = (params.subtitle ?? '').trim();
  if (!action) return snippet;
  if (!snippet) return action;
  const actionBare = action.replace(/[:.!?]+$/, '');
  if (actionBare && snippet.toLowerCase().includes(actionBare.toLowerCase())) return snippet;
  return `${action}\n${snippet}`;
}
