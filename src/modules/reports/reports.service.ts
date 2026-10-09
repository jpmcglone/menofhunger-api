import { MessagesMembershipService } from "../messages";
import { ChannelMediaService } from "../group-channels/channel-media.service";
import { toPage } from "../../common/pagination/page";
import { ChannelAccessService } from "../group-channels/channel-access.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import type {
  Prisma,
  ReportReason,
  ReportStatus,
  ReportTargetType,
} from "@prisma/client";
import {
  Injectable,
  NotFoundException,
  Optional,
  Inject,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { createdAtIdCursorWhere } from "../../common/pagination/created-at-id-cursor";
import { SlackService } from "../../common/slack/slack.service";

import { PostsReadService } from "../posts-read/posts-read.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { USER_BRIEF_SELECT } from "../../common/prisma-selects/user.select";
import { NOT_DELETED } from "../../common/prisma/where";
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slack: SlackService,
    private readonly channels: ChannelAccessService,
    @Inject(MessagesMembershipService)
    private readonly messages: Pick<
      MessagesMembershipService,
      "listConversationParticipantUserIds"
    >,
    private readonly viewer: ViewerContextService,
    private readonly channelMedia: ChannelMediaService,
    private readonly postsRead: PostsReadService,
    @Optional() private readonly sideEffects?: SideEffectsService,
  ) {}

  readReportedMedia(
    reportId: string,
    mediaId: string,
    thumbnail: boolean,
    range?: string,
  ) {
    return this.channelMedia.readReportedMedia(
      reportId,
      mediaId,
      thumbnail,
      range,
    );
  }

  async create(input: Parameters<ReportsService["createRecord"]>[0]) {
    const report = await this.createRecord(input);
    // Jev's first opinion runs off the request path and only orders the admin queue.
    this.sideEffects?.dispatch("report.score", { reportId: report.id });
    return report;
  }

  private async createRecord(input: {
    reporterUserId: string;
    targetType: ReportTargetType;
    subjectPostId?: string | null;
    subjectUserId?: string | null;
    subjectMessageId?: string | null;
    subjectArticleId?: string | null;
    reason: ReportReason;
    details: string | null;
  }) {
    if (input.targetType === "message") {
      const message = input.subjectMessageId
        ? await this.prisma.message.findFirst({
            where: { id: input.subjectMessageId, deletedForAll: false },
            include: { conversation: { include: { groupChannel: true } } },
          })
        : null;
      if (!message) throw new NotFoundException("Message unavailable.");
      const channel = message.conversation.groupChannel;
      if (channel)
        await this.channels.channel(
          input.reporterUserId,
          channel.groupId,
          channel.id,
        );
      else
        await this.messages.listConversationParticipantUserIds({
          userId: input.reporterUserId,
          conversationId: message.conversationId,
        });
      return this.prisma.report.create({
        data: {
          targetType: "message",
          subjectMessageId: message.id,
          reporterUserId: input.reporterUserId,
          reason: input.reason,
          details: input.details,
          evidenceText: message.body,
        },
      });
    }
    if (input.targetType === "article") {
      const article = input.subjectArticleId
        ? await this.prisma.article.findFirst({
            where: { id: input.subjectArticleId, ...NOT_DELETED },
          })
        : null;
      const viewer = await this.viewer.getViewer(input.reporterUserId);
      if (
        !article ||
        (article.authorId !== input.reporterUserId &&
          (article.isDraft ||
            !this.viewer
              .allowedPostVisibilities(viewer)
              .includes(article.visibility)))
      )
        throw new NotFoundException("Article unavailable.");
      return this.prisma.report.create({
        data: {
          targetType: "article",
          subjectArticleId: article.id,
          reporterUserId: input.reporterUserId,
          reason: input.reason,
          details: input.details,
          evidenceText: `${article.title}\n${article.body}`,
        },
      });
    }
    if (input.targetType === "post") {
      const postId = input.subjectPostId;
      if (!postId) throw new NotFoundException();

      const post = await this.postsRead.findFirst({
        where: { id: postId, ...NOT_DELETED },
        select: { id: true },
      });
      if (!post) throw new NotFoundException();

      const postReport = await this.prisma.report.create({
        data: {
          targetType: "post",
          reason: input.reason,
          details: input.details,
          reporter: { connect: { id: input.reporterUserId } },
          subjectPost: { connect: { id: postId } },
        },
      });
      this.slack.notifyReportSubmitted({
        targetType: "post",
        reason: input.reason,
        details: input.details,
        reporterUserId: input.reporterUserId,
      });
      return postReport;
    }

    const userId = input.subjectUserId;
    if (!userId) throw new NotFoundException();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException();

    const userReport = await this.prisma.report.create({
      data: {
        targetType: "user",
        reason: input.reason,
        details: input.details,
        reporter: { connect: { id: input.reporterUserId } },
        subjectUser: { connect: { id: userId } },
      },
    });
    this.slack.notifyReportSubmitted({
      targetType: "user",
      reason: input.reason,
      details: input.details,
      reporterUserId: input.reporterUserId,
    });
    return userReport;
  }

  async listAdmin(params: {
    limit: number;
    cursor: string | null;
    status?: ReportStatus;
    targetType?: ReportTargetType;
    reason?: ReportReason;
    q?: string;
    /** `likely`: Jev's most-likely-real first (offset cursor). Default: newest first. */
    sort?: "newest" | "likely";
  }) {
    const likely = params.sort === "likely";
    const offset = likely
      ? Math.max(0, Number.parseInt(params.cursor ?? "", 10) || 0)
      : 0;
    const cursorWhere = likely
      ? null
      : await createdAtIdCursorWhere({
          cursor: params.cursor,
          lookup: async (id) =>
            this.prisma.report.findUnique({
              where: { id },
              select: { id: true, createdAt: true },
            }),
        });

    const whereParts: Prisma.ReportWhereInput[] = [];
    if (cursorWhere) whereParts.push(cursorWhere);
    if (params.status) whereParts.push({ status: params.status });
    if (params.targetType) whereParts.push({ targetType: params.targetType });
    if (params.reason) whereParts.push({ reason: params.reason });

    const q = (params.q ?? "").trim();
    if (q) {
      whereParts.push({
        OR: [
          { details: { contains: q, mode: "insensitive" } },
          { adminNote: { contains: q, mode: "insensitive" } },
        ],
      });
    }

    const where = whereParts.length ? { AND: whereParts } : undefined;

    const rows = await this.prisma.report.findMany({
      where,
      orderBy: likely
        ? [
            { jevPriority: { sort: "desc", nulls: "last" } },
            { createdAt: "desc" },
            { id: "desc" },
          ]
        : [{ createdAt: "desc" }, { id: "desc" }],
      ...(likely ? { skip: offset } : {}),
      take: params.limit + 1,
      include: {
        reporter: { select: USER_BRIEF_SELECT },
        subjectMessage: {
          select: {
            id: true,
            createdAt: true,
            deletedForAll: true,
            senderId: true,
            media: { select: { id: true, kind: true } },
          },
        },
        subjectArticle: {
          select: { id: true, title: true, slug: true, deletedAt: true },
        },
        subjectUser: { select: USER_BRIEF_SELECT },
        subjectPost: {
          select: {
            id: true,
            createdAt: true,
            body: true,
            deletedAt: true,
            user: { select: USER_BRIEF_SELECT },
          },
        },
        resolvedByAdmin: { select: USER_BRIEF_SELECT },
      },
    });

    const { items, nextCursor } = toPage(rows, params.limit, (last) =>
      likely ? String(offset + params.limit) : last.id,
    );
    return { rows: items, nextCursor };
  }

  async updateAdmin(
    id: string,
    input: {
      adminId: string;
      status?: ReportStatus;
      adminNote?: string | null;
    },
  ) {
    const setResolution =
      input.status === undefined
        ? {}
        : input.status === "pending"
          ? { resolvedAt: null, resolvedByAdmin: { disconnect: true } }
          : {
              resolvedAt: new Date(),
              resolvedByAdmin: { connect: { id: input.adminId } },
            };

    return await this.prisma.report.update({
      where: { id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.adminNote !== undefined
          ? { adminNote: input.adminNote }
          : {}),
        ...setResolution,
      },
      include: {
        reporter: { select: USER_BRIEF_SELECT },
        subjectMessage: {
          select: {
            id: true,
            createdAt: true,
            deletedForAll: true,
            senderId: true,
            media: { select: { id: true, kind: true } },
          },
        },
        subjectArticle: {
          select: { id: true, title: true, slug: true, deletedAt: true },
        },
        subjectUser: { select: USER_BRIEF_SELECT },
        subjectPost: {
          select: {
            id: true,
            createdAt: true,
            body: true,
            deletedAt: true,
            user: { select: USER_BRIEF_SELECT },
          },
        },
        resolvedByAdmin: { select: USER_BRIEF_SELECT },
      },
    });
  }
}
