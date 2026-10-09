import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildGroupEmail, type GroupEmailKind } from './email-content-group';
import { buildGreeting, getVerifiedRecipientEmail, preferredDisplayName } from './email-send.helpers';
import { EmailService } from './email.service';
import { NOT_DELETED } from '../../common/prisma/where';

export type GroupEmailInput = {
  kind: GroupEmailKind;
  recipientUserId: string;
  groupId: string;
  actorUserId?: string | null;
  inviteId?: string | null;
  note?: string | null;
  channel?: { id: string; label: string; isPrivate: boolean } | null;
  messageId?: string | null;
  excerpt?: string | null;
};

/**
 * Best-effort transactional-style emails for groups. Invites carry a deep link to
 * `/g/<slug>?invite=<id>`; the client signs in, verifies, accepts and routes. The link
 * itself never mutates anything, so forwarding or prefetching it is harmless.
 */
@Injectable()
export class GroupEmailService {
  private readonly logger = new Logger(GroupEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfigService,
  ) {}

  async send(input: GroupEmailInput): Promise<boolean> {
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return false;
    const [user, group, actor] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: input.recipientUserId },
        select: {
          id: true, email: true, emailVerifiedAt: true, name: true, username: true,
          notificationPreferences: { select: { emailInstantHighSignal: true } },
        },
      }),
      this.prisma.communityGroup.findFirst({ where: { id: input.groupId, ...NOT_DELETED }, select: { slug: true, name: true } }),
      input.actorUserId
        ? this.prisma.user.findUnique({ where: { id: input.actorUserId }, select: { name: true, username: true } })
        : Promise.resolve(null),
    ]);
    if (!user || !group) return false;
    if (user.notificationPreferences?.emailInstantHighSignal === false) return false;
    const to = getVerifiedRecipientEmail(user);
    if (!to) return false;

    const base = ((this.appConfig.frontendBaseUrl() ?? '').trim() || 'https://menofhunger.com').replace(/\/$/, '');
    const slug = encodeURIComponent(group.slug);
    let url = `${base}/g/${slug}`;
    if (input.kind === 'invite' && input.inviteId) url += `?invite=${encodeURIComponent(input.inviteId)}`;
    if (input.kind === 'mention' && input.channel) {
      url = `${base}/groups/${slug}/channels/${encodeURIComponent(input.channel.id)}`;
      if (input.messageId) url += `?message=${encodeURIComponent(input.messageId)}`;
    }

    // Private channels never leak names or text outside the app.
    const isPrivate = Boolean(input.channel?.isPrivate);
    const rendered = buildGroupEmail({
      kind: input.kind,
      greeting: buildGreeting({ name: user.name, username: user.username }),
      groupName: group.name,
      actorName: actor ? preferredDisplayName(actor) : null,
      note: input.note,
      channelLabel: isPrivate ? null : input.channel?.label,
      excerpt: isPrivate ? null : input.excerpt,
      url,
      settingsUrl: `${base}/settings/notifications`,
    });
    const sent = await this.email.sendText({
      to,
      from: emailCfg.fromEmail.notifications || emailCfg.fromEmail.default || emailCfg.fromEmail.newsletter,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      category: 'engagement',
      userId: user.id,
    });
    if (!sent.sent) this.logger.debug(`[group-email] ${input.kind} skipped ${user.id}: ${sent.reason ?? 'unknown'}`);
    return sent.sent;
  }
}
