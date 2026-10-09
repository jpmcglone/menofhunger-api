import { Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

import { NotificationCreatorService } from "./notification-creator.service";

@Injectable()
export class NotificationMarvWriterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly creator: NotificationCreatorService,
  ) {}

  /**
   * Notify a user that they mentioned @marv in a group where he is not a member,
   * so he will not respond. Rate-limited to once per hour per (user, group) pair
   * to avoid spam if someone mentions @marv repeatedly.
   *
   * - actorUserId = Marv (drives his avatar on the notification row)
   * - actorPostId = the post that triggered the mention (tap target)
   * - subjectGroupId = the group
   */
  async upsertMarvNotInGroupNotification(params: {
    recipientUserId: string;
    marvUserId: string;
    postId: string;
    groupId: string;
  }): Promise<void> {
    const { recipientUserId, marvUserId, postId, groupId } = params;

    // Rate-limit: skip if we already sent this notification for this user + group within the last hour.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.prisma.notification.findFirst({
      where: {
        recipientUserId,
        kind: "marv_not_in_group",
        subjectGroupId: groupId,
        createdAt: { gte: oneHourAgo },
      },
      select: { id: true },
    });
    if (recent) return;

    const group = await this.prisma.communityGroup.findUnique({
      where: { id: groupId },
      select: { name: true },
    });
    const groupName = group?.name?.trim() || null;
    const groupLabel = groupName ? `**${groupName}**` : "this group";

    await this.creator.create({
      recipientUserId,
      kind: "marv_not_in_group",
      actorUserId: marvUserId,
      actorPostId: postId,
      subjectGroupId: groupId,
      body: `@marv is not in ${groupLabel}, so he won't respond. Ask an owner to add him!`,
    });
  }
}
