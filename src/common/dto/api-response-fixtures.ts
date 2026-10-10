import type { FollowSummary } from "../../modules/follows/follows.constants";
import type { UserDto } from "./user.dto";
import { TOPIC_OPTIONS } from "../topics/topic-options";
import type { PostDto } from "./post.dto";
import type { CommunityGroupShellDto } from "./community-group.dto";
import type { GroupChannelDto } from "./group-channel.dto";
import type {
  MessageDto,
  MessageConversationDto,
} from "../../modules/messages/message.dto";
import type { NotificationDto } from "../../modules/notifications/notification.dto";
import type { CheckinScheduleDto } from "../../modules/checkins/checkin-schedule.dto";
import { NOT_DELETED } from "../prisma/where";

// Synthetic examples owned by the API. Pick constrains representative wire subsets
// without inventing server fields or making fixture-only data part of the public contract.
const createdAt = "2026-10-10T22:00:00.000Z";
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "john",
  name: "John",
  usernameIsSet: true,
  bio: null,
  email: null,
  avatarUrl: null,
  birthdate: "1990-01-01",
  menOnlyConfirmed: true,
  interests: ["strength_training"],
  verifiedStatus: "manual",
  premium: false,
  premiumPlus: false,
  siteAdmin: false,
  accountKind: "person",
  checkinStreakDays: 3,
} satisfies Pick<
  UserDto,
  | "id"
  | "username"
  | "name"
  | "usernameIsSet"
  | "bio"
  | "email"
  | "avatarUrl"
  | "birthdate"
  | "menOnlyConfirmed"
  | "interests"
  | "verifiedStatus"
  | "premium"
  | "premiumPlus"
  | "siteAdmin"
  | "accountKind"
  | "checkinStreakDays"
>;
const author = {
  id: user.id,
  username: user.username,
  name: user.name,
  premium: false,
  premiumPlus: false,
  isOrganization: false,
  verifiedStatus: user.verifiedStatus,
  avatarUrl: null,
  orgAffiliations: [],
};
const post = {
  id: "22222222-2222-4222-8222-222222222222",
  author,
  body: "Showed up today.",
  createdAt,
  kind: "regular",
  visibility: "verifiedOnly",
  parentId: null,
  communityGroupId: null,
  ...NOT_DELETED,
  media: [],
  boostCount: 2,
  commentCount: 0,
  viewerHasBoosted: false,
  checkinPrompt: null,
  poll: null,
} satisfies Pick<
  PostDto,
  | "id"
  | "author"
  | "body"
  | "createdAt"
  | "kind"
  | "visibility"
  | "parentId"
  | "communityGroupId"
  | "deletedAt"
  | "media"
  | "boostCount"
  | "commentCount"
  | "viewerHasBoosted"
  | "checkinPrompt"
  | "poll"
>;
const group = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "builders",
  name: "Builders",
  description: "Build together.",
  rules: null,
  avatarImageUrl: null,
  joinPolicy: "open",
  memberCount: 2,
  viewerMembership: { status: "active", role: "member" },
  viewerPendingApproval: false,
  channelsAvailable: true,
} satisfies Pick<
  CommunityGroupShellDto,
  | "id"
  | "slug"
  | "name"
  | "description"
  | "rules"
  | "avatarImageUrl"
  | "joinPolicy"
  | "memberCount"
  | "viewerMembership"
  | "viewerPendingApproval"
  | "channelsAvailable"
>;
const channel = {
  id: "44444444-4444-4444-8444-444444444444",
  groupId: group.id,
  name: "general",
  displayName: null,
  topic: "",
  privacy: "normal",
  hasUnread: true,
  personalCount: 1,
  preference: "mentions",
  readThrough: 1,
  capabilities: {
    canSend: true,
    canReact: true,
    canManage: false,
    canInvite: false,
    canModerate: false,
    canArchive: false,
    canRename: false,
  },
} satisfies Pick<
  GroupChannelDto,
  | "id"
  | "groupId"
  | "name"
  | "displayName"
  | "topic"
  | "privacy"
  | "hasUnread"
  | "personalCount"
  | "preference"
  | "readThrough"
  | "capabilities"
>;
const message = {
  id: "55555555-5555-4555-8555-555555555555",
  clientRequestId: null,
  conversationId: "66666666-6666-4666-8666-666666666666",
  body: "Good to see you.",
  createdAt,
  sender: author,
  kind: "text",
  deletedForAll: false,
  deletedForMe: false,
  media: [],
} satisfies Pick<
  MessageDto,
  | "id"
  | "clientRequestId"
  | "conversationId"
  | "body"
  | "createdAt"
  | "sender"
  | "kind"
  | "deletedForAll"
  | "deletedForMe"
  | "media"
>;
const conversation = {
  id: message.conversationId,
  type: "direct",
  title: null,
  unreadCount: 1,
  isMuted: false,
  viewerStatus: "accepted",
  isBlockedWith: false,
  activeCall: null,
  lastMessage: null,
  participants: [
    {
      user: author,
      status: "accepted",
      role: "member",
      acceptedAt: createdAt,
      lastReadAt: null,
      banned: false,
    },
  ],
} satisfies Pick<
  MessageConversationDto,
  | "id"
  | "type"
  | "title"
  | "unreadCount"
  | "isMuted"
  | "viewerStatus"
  | "isBlockedWith"
  | "activeCall"
  | "lastMessage"
  | "participants"
>;
const notification = {
  id: "77777777-7777-4777-8777-777777777777",
  kind: "comment",
  createdAt,
  actor: author,
  readAt: null,
  deliveredAt: createdAt,
  body: "Replied to your post",
  title: null,
  subjectPostId: post.id,
  actorPostId: post.id,
  actionPath: `/p/${post.id}`,
} satisfies Pick<
  NotificationDto,
  | "id"
  | "kind"
  | "createdAt"
  | "actor"
  | "readAt"
  | "deliveredAt"
  | "body"
  | "title"
  | "subjectPostId"
  | "actorPostId"
  | "actionPath"
>;
const checkinSchedule = {
  dayKey: "2026-10-10",
  isOpen: true,
  opensAt: "2026-10-10T21:00:00.000Z",
  closesAt: "2026-10-11T04:00:00.000Z",
} satisfies CheckinScheduleDto;
const completePost = {
  ...post,
  editedAt: createdAt,
  editCount: 1,
  checkinDayKey: "2026-10-10",
  isDraft: false,
  topics: [],
  hashtags: [],
  cashtags: [],
  bookmarkCount: 3,
  repostCount: 2,
  viewerCount: 7,
  totalViewCount: 31,
  mentions: [
    {
      id: user.id,
      username: user.username,
      verifiedStatus: user.verifiedStatus,
    },
  ],
  viewerHasBookmarked: true,
  viewerHasReposted: true,
  viewerHasCommented: false,
  viewerHasViewed: true,
  viewerBookmarkCollectionIds: ["folder-1"],
  replyPrompt: "question",
  pickaxUrl: "https://pickax.com/example",
  pickaxError: null,
  xUrl: null,
  xError: null,
  author: { ...author, isNewMember: true },
} satisfies PostDto;
const richPost = {
  ...completePost,
  kind: "checkin",
  checkinPrompt: "What did you follow through on?",
  groupPreview: {
    id: group.id,
    slug: group.slug,
    name: group.name,
    descriptionPreview: group.description,
    avatarImageUrl: null,
    coverImageUrl: null,
    joinPolicy: group.joinPolicy,
    memberCount: group.memberCount,
    viewerMembership: group.viewerMembership,
    viewerPendingApproval: false,
  },
  pinnedInGroupAt: createdAt,
  quotedPost: completePost,
  poll: {
    id: "poll-1",
    endsAt: "2026-10-11T22:00:00.000Z",
    ended: false,
    totalVoteCount: 3,
    viewerHasVoted: true,
    viewerVotedOptionId: "option-1",
    options: [
      {
        id: "option-1",
        text: "Show up",
        imageUrl: null,
        width: null,
        height: null,
        alt: null,
        voteCount: 2,
        percent: 67,
      },
      {
        id: "option-2",
        text: "Keep going",
        imageUrl: null,
        width: null,
        height: null,
        alt: null,
        voteCount: 1,
        percent: 33,
      },
    ],
  },
  conversationContext: { kind: "unanswered", reply: null, relatedPostId: null },
} satisfies PostDto;

const followSummary = {
  canView: true,
  followerCount: 24,
  followingCount: 18,
  viewerFollowsUser: false,
  userFollowsViewer: false,
  viewerPostNotificationsEnabled: false,
  nudge: null,
  followedBy: null,
} satisfies FollowSummary;

const responses = {
  followSummary: { data: followSummary },
  followSummaryHidden: {
    data: {
      ...followSummary,
      canView: false,
      followerCount: null,
      followingCount: null,
    },
  },
  followSummaryMissing: { data: {} },

  richPost: { data: richPost },
  repost: {
    data: {
      ...completePost,
      id: "repost-shell",
      kind: "repost",
      repostedPost: completePost,
      repostedByAuthors: [
        author,
        { ...author, id: "second-author", name: "Marcus" },
      ],
      repostedByCount: 3,
    } satisfies PostDto,
  },
  notificationPost: {
    data: [
      {
        type: "single",
        notification: {
          ...notification,
          post: richPost,
          subjectPostPreview: {
            bodySnippet: completePost.body,
            kind: completePost.kind,
            media: [],
          },
        },
      },
    ],
  },
  topics: {
    data: TOPIC_OPTIONS.filter((topic) =>
      ["strength_training", "entrepreneurship"].includes(topic.value),
    ).map(({ value, label, group, aliases }) => ({
      value,
      label,
      group,
      aliases,
    })),
  },
  auth: { data: user },
  signedOut: { data: null },
  login: {
    data: {
      user,
      isNewUser: false,
      sessionId: "not-an-authentication-token",
      accountDeletionCancelled: false,
    },
  },
  feed: { data: [post], pagination: { nextCursor: null } },
  checkin: {
    data: {
      ...checkinSchedule,
      prompt: "What did you follow through on?",
      hasCheckedInToday: false,
      checkinStreakDays: 3,
      allowedVisibilities: ["verifiedOnly"],
    },
  },
  groups: { data: [group] },
  channels: { data: [channel] },
  conversation: { data: { conversation, messages: [message] } },
  channelHistory: {
    data: [
      {
        ...message,
        channelId: channel.id,
        sequence: 2,
        revision: 1,
        threadRootId: null,
        clientRequestId: null,
        replyCount: 0,
      },
    ],
    pagination: { nextCursor: null, latestSequence: 2 },
  },
  notifications: {
    data: [{ type: "single", notification }],
    pagination: { nextCursor: null },
  },
  notificationsGroup: {
    data: [
      {
        type: "group",
        group: {
          id: notification.id,
          kind: "comment",
          createdAt,
          readAt: null,
          deliveredAt: createdAt,
          actors: [author],
          count: 2,
          actorCount: 1,
          latestBody: "A reply",
          subjectPostId: post.id,
        },
      },
    ],
    pagination: { nextCursor: null },
  },
};

// Platform-neutral examples grouped by the API domain they describe.
export const apiResponseFixturesByDomain = {
  auth: {
    topics: responses.topics,
    auth: responses.auth,
    signedOut: responses.signedOut,
    login: responses.login,
  },
  posts: {
    feed: responses.feed,
    richPost: responses.richPost,
    repost: responses.repost,
  },
  follows: {
    followSummary: responses.followSummary,
    followSummaryHidden: responses.followSummaryHidden,
    followSummaryMissing: responses.followSummaryMissing,
  },
  checkins: {
    checkin: responses.checkin,
  },
  groups: {
    groups: responses.groups,
    channels: responses.channels,
  },
  messages: {
    conversation: responses.conversation,
    channelHistory: responses.channelHistory,
    photo: {
      data: {
        message: {
          ...message,
          clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          body: "",
          media: [
            {
              id: "uploaded-photo",
              source: "upload",
              kind: "image",
              url: "https://cdn.example.test/uploads/member/images/photo.jpg",
              thumbnailUrl: null,
              mp4Url: null,
              width: 640,
              height: 480,
              durationSeconds: null,
              alt: "Trail at dawn",
              transcriptStatus: null,
              transcript: null,
              ...NOT_DELETED,
            },
          ],
        },
      },
    },
    deletedPhoto: {
      data: {
        message: {
          ...message,
          body: "",
          media: [
            {
              id: "deleted-photo",
              source: "upload",
              kind: "image",
              url: "",
              thumbnailUrl: null,
              mp4Url: null,
              width: 640,
              height: 480,
              durationSeconds: null,
              alt: null,
              transcriptStatus: null,
              transcript: null,
              deletedAt: createdAt,
            },
          ],
        },
      },
    },
  },
  notifications: {
    notifications: responses.notifications,
    notificationsGroup: responses.notificationsGroup,
    notificationPost: responses.notificationPost,
  },
};
