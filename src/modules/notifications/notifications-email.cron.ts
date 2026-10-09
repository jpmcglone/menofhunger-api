import { createHash } from 'node:crypto';
import { MessagesConversationStateService } from "../messages";
import { NotificationsEmailSupportService } from "./notifications-email-support.service";
import { USER_BRIEF_SELECT } from '../../common/prisma-selects/user.select';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AppConfigService } from '../app/app-config.service';
import { buildFollowedArticleEmail, renderTiptapPreviewHtml } from '../email/email-content-article';
import { buildGreeting, getRecipientEmail, getVerifiedRecipientEmail } from '../email/email-send.helpers';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { messagePreviewText } from '../messages/message.dto';
import { EMAIL, escapeHtml, renderButton, renderCard, renderMohEmail, renderPill } from '../email/templates/moh-email';
import { publicAssetUrl } from '../../common/assets/public-asset-url';

import { PostsReadService } from '../posts-read/posts-read.service';

import { safeBaseUrl, truncate } from "./notifications-email.helpers";

@Injectable()
export class NotificationsEmailCron {
  private readonly logger = new Logger(NotificationsEmailCron.name);

  private readonly INSTANT_EMAIL_DELAY_MS = 2 * 60_000;
  // Raised from 15m: instant email is a supplement to push, not a race.
  // Still delivers within a business hour for most users.
  private readonly INSTANT_EMAIL_COOLDOWN_MS = 6 * 60 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
    @Inject(MessagesConversationStateService) private readonly messages: Pick< MessagesConversationStateService, "getUnreadSummary" >,
    private readonly postsRead: PostsReadService,
    private readonly support: NotificationsEmailSupportService,
  ) {}

  @Cron('*/15 * * * *')
  async sendNewNotificationsNudges(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    try {
      await this.jobs.enqueueCron(JOBS.notificationsEmailNudges, {}, 'cron-notificationsEmailNudges', {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runSendNewNotificationsNudges(): Promise<void> {
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    try {
      const now = new Date();
      // Raised from 12h: one nudge every 2 days conserves quota while still catching lurkers.
      const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);
      const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
      const notificationsUrl = `${baseUrl}/notifications`;

      // Important: users may not have a NotificationPreferences row yet.
      // Treat "no row" as defaults-on, and upsert the timestamp after sending.
      //
      // Recipient gate: either the bell counter is > 0 (regular notifications)
      // OR the user has unread community_group_post rows (badge-only, never counted
      // by undeliveredNotificationCount but still eligible for email nudges).
      const preferenceCondition = {
        OR: [
          // No preferences row yet → defaults apply → eligible.
          { notificationPreferences: { is: null } },
          // Preferences row exists → only if nudges enabled and not recently sent.
          {
            notificationPreferences: {
              is: {
                emailNewNotifications: true,
                OR: [{ lastEmailNewNotificationsSentAt: null }, { lastEmailNewNotificationsSentAt: { lt: cutoff } }],
              },
            },
          },
        ],
      };
      const recipients = await this.prisma.user.findMany({
        where: {
          email: { not: null },
          emailVerifiedAt: { not: null },
          AND: [
            {
              OR: [
                { undeliveredNotificationCount: { gt: 0 } },
                {
                  notificationsReceived: {
                    some: {
                      kind: 'community_group_post',
                      deliveredAt: null,
                      readAt: null,
                      presentAt: null,
                    },
                  },
                },
              ],
            },
            preferenceCondition,
          ],
        },
        orderBy: [{ id: 'asc' }],
        take: 500,
        select: {
          id: true,
          email: true,
          username: true,
          name: true,
          undeliveredNotificationCount: true,
        },
      });

      const [recentByRecipientId, emailableCountById] = await Promise.all([
        this.support.listRecentNotificationItemsByRecipientIds(recipients.map((u) => u.id)),
        this.support.listEmailableNotificationCountsByRecipientIds(recipients.map((u) => u.id)),
      ]);
      for (const u of recipients) {
        const to = getRecipientEmail(u.email);
        if (!to) continue;

        // Use the precise emailable count (deliveredAt, readAt, presentAt all null).
        // Notifications the user was present for when they arrived are excluded so we
        // never email about something they already saw live.
        const undelivered = emailableCountById.get(u.id) ?? 0;
        if (undelivered <= 0) continue;

        const recent = recentByRecipientId.get(u.id) ?? [];

        const recentItems = recent
          .map((n) => {
            const title = (n.title ?? 'New notification').trim();
            const body = (n.body ?? '').trim();
            const text = `${title}${body ? ` — ${body}` : ''}`.trim();
            const href = n.subjectPostId ? `${baseUrl}/p/${encodeURIComponent(n.subjectPostId)}` : notificationsUrl;
            return { text, href };
          })
          .filter((x) => Boolean(x.text));

        const lines = recentItems.map((it) => {
          // Keep plain text concise; only include a direct link when we have a specific destination.
          const direct = it.href !== notificationsUrl ? ` (${it.href})` : '';
          return `- ${it.text}${direct}`;
        });

        const greeting = buildGreeting({ name: u.name, username: u.username, tone: 'hey' });

        const text = [
          greeting,
          '',
          `You have ${undelivered} new notification${undelivered === 1 ? '' : 's'} on Men of Hunger.`,
          '',
          ...(lines.length ? ['Recent:', ...lines, ''] : []),
          `Open: ${notificationsUrl}`,
          '',
          `You can change email notification settings in Settings → Notifications.`,
        ].join('\n');

        const recentHtml = recentItems.length
          ? renderCard(
              [
                `<div style="font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL.muted};">Recent</div>`,
                `<ul style="margin:10px 0 0 18px;padding:0;color:${EMAIL.text};font-size:14px;line-height:1.6;">`,
                ...recentItems.map(
                  (it) =>
                    `<li style="margin:0 0 8px 0;"><a href="${escapeHtml(it.href)}" style="color:${EMAIL.text};text-decoration:none;">${escapeHtml(
                      it.text,
                    )}</a></li>`,
                ),
                `</ul>`,
              ].join(''),
            )
          : '';

        const html = renderMohEmail({
          title: `Unread notifications`,
          preheader: `You have ${undelivered} new notification${undelivered === 1 ? '' : 's'}.`,
          contentHtml: [
            `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:${EMAIL.text};">You have ${undelivered} new notification${
              undelivered === 1 ? '' : 's'
            }</div>`,
            `<div style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:${EMAIL.muted};">${escapeHtml(greeting)}</div>`,
            `<div style="margin-top:10px;display:block;">${renderButton({ href: notificationsUrl, label: 'Open notifications' })}</div>`,
            recentHtml,
            `<div style="margin-top:14px;font-size:13px;line-height:1.7;color:${EMAIL.muted};">Manage email notification settings: <a href="${escapeHtml(
              `${baseUrl}/settings/notifications`,
            )}" style="color:${EMAIL.text};text-decoration:underline;">Settings → Notifications</a></div>`,
          ].join(''),
          footerHtml: `Manage notifications in <a href="${escapeHtml(`${baseUrl}/settings/notifications`)}" style="color:${EMAIL.soft};text-decoration:underline;">Settings → Notifications</a> · Men of Hunger`,
        });

        await this.support.sendEmailAndHandle({
          to,
          subject: `You have ${undelivered} new notification${undelivered === 1 ? '' : 's'}`,
          text,
          html,
          userId: u.id,
          logTag: 'email-nudges',
          preference: 'emailNewNotifications',
          eventKey: `notification-nudge:${u.id}:${now.toISOString().slice(0, 10)}`,
          onSent: async () => {
            await this.prisma.notificationPreferences.upsert({
              where: { userId: u.id },
              create: { userId: u.id, lastEmailNewNotificationsSentAt: now },
              update: { lastEmailNewNotificationsSentAt: now },
            });
          },
        });
      }
    } catch (err) {
      this.logger.error(
        `[email-nudges] run failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  /** Weekly digest (send once per week on Sundays; target 8am ET, DST-safe). */
  /**
   * Near-immediate high-signal email (optional, user-controlled):
   * - New direct message activity
   * - Mentions + replies (notification kinds: mention, comment)
   *
   * This job is intended to be enqueued with a short delay so multiple events can batch.
   */
  async runSendInstantHighSignalEmail(payload: unknown): Promise<void> {
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    try {
      const rawUserId = (payload as { userId?: unknown } | null | undefined)?.userId;
      const userId = typeof rawUserId === 'string' ? rawUserId.trim() : '';
      if (!userId) return;

    const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
    const notificationsUrl = `${baseUrl}/notifications`;
    const chatBaseUrl = `${baseUrl}/chat`;
    const settingsUrl = `${baseUrl}/settings/notifications`;

    const now = new Date();
    const prefs = await this.prisma.notificationPreferences.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: {
        emailInstantHighSignal: true,
        lastEmailInstantHighSignalSentAt: true,
        user: { select: { email: true, emailVerifiedAt: true, username: true, name: true } },
      },
    });

    const to = getVerifiedRecipientEmail({
      email: prefs.user.email,
      emailVerifiedAt: prefs.user.emailVerifiedAt,
    });
    if (!to) return;
    if (!prefs.emailInstantHighSignal) return;

    const lastSent = prefs.lastEmailInstantHighSignalSentAt;
    if (lastSent && now.getTime() - lastSent.getTime() < this.INSTANT_EMAIL_COOLDOWN_MS) return;

    const since = lastSent ? lastSent : new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [notifs, unreadChats, unreadConversations] = await Promise.all([
      this.prisma.notification.findMany({
        where: {
          recipientUserId: userId,
          kind: { in: ['mention', 'comment'] },
          // Smart-cancel: skip notifications the user already saw — either by opening
          // the bell (deliveredAt), tapping through (readAt), or by being actively
          // present in the app when the notification arrived (presentAt).
          deliveredAt: null,
          readAt: null,
          presentAt: null,
          createdAt: { gt: since },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 8,
        select: {
          id: true,
          kind: true,
          title: true,
          body: true,
          createdAt: true,
          subjectPostId: true,
          actor: { select: { username: true, name: true, premium: true, premiumPlus: true, isOrganization: true, verifiedStatus: true } },
          subjectPost: { select: { visibility: true } },
        },
      }),
      this.messages.getUnreadSummary(userId)
        .then((c) => (c.primary ?? 0) + (c.requests ?? 0))
        .catch(() => 0),
      this.prisma.messageParticipant.findMany({
        where: { userId, status: 'accepted' },
        select: {
          updatedAt: true,
          lastReadAt: true,
          conversation: {
            select: {
              id: true,
              lastMessageAt: true,
              lastMessage: {
                select: {
                  senderId: true,
                  body: true,
                  createdAt: true,
                  deletedForAll: true,
                  media: { select: { kind: true }, take: 1, orderBy: [{ createdAt: 'asc' }] },
                  sender: { select: { username: true, name: true } },
                },
              },
            },
          },
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 6,
      }),
    ]);

    const hasHighSignalNotifs = Array.isArray(notifs) && notifs.length > 0;
    const hasUnreadChats = unreadChats > 0;
    if (!hasHighSignalNotifs && !hasUnreadChats) return;

    const mentionCount = hasHighSignalNotifs ? notifs.filter((n) => n.kind === 'mention').length : 0;
    const replyCount = hasHighSignalNotifs ? notifs.filter((n) => n.kind === 'comment').length : 0;
    const notifsNoun =
      mentionCount > 0 && replyCount > 0 ? 'mentions and replies' : mentionCount > 0 ? 'mentions' : replyCount > 0 ? 'replies' : 'activity';

    const greeting = buildGreeting({ name: prefs.user.name, username: prefs.user.username, tone: 'hey' });

    const subject =
      hasUnreadChats && hasHighSignalNotifs
        ? `New messages and ${notifsNoun} on Men of Hunger`
        : hasUnreadChats
          ? `You have new messages on Men of Hunger`
          : `You have new ${notifsNoun} on Men of Hunger`;

    const chatPreviewRows = hasUnreadChats
      ? ((unreadConversations ?? [])
          .map((p) => {
            const lastReadAt = p.lastReadAt ?? null;
            const conv = p.conversation ?? null;
            const lastMsg = conv?.lastMessage ?? null;
            if (!conv?.id || !conv.lastMessageAt || !lastMsg) return null;
            // Only show previews for unread messages from someone else.
            if (lastReadAt && conv.lastMessageAt.getTime() <= lastReadAt.getTime()) return null;
            if (lastMsg.senderId === userId) return null;
            const sender = (lastMsg.sender?.name ?? lastMsg.sender?.username ?? 'Someone').trim();
            const body = truncate(messagePreviewText(lastMsg), 140);
            if (!body) return null;
            const href = `${chatBaseUrl}?c=${encodeURIComponent(conv.id)}`;
            return { sender, body, href };
          })
          .filter(Boolean)
          .slice(0, 3) as Array<{ sender: string; body: string; href: string }>)
      : [];

    // Best link target for "Open chat" buttons: the newest unread conversation if we can infer it.
    const chatUrl = chatPreviewRows[0]?.href ?? chatBaseUrl;

    const notifLines = notifs.map((n) => {
      const actorRealName = (n.actor?.name ?? '').trim();
      const actorUser = (n.actor?.username ?? '').trim();
      const actor = actorRealName || (actorUser ? `@${actorUser}` : 'Someone');
      const label = n.kind === 'comment' ? 'Reply' : 'Mention';
      const msg = truncate((n.body ?? n.title ?? '').trim(), 140);
      return `- ${label} from ${actor}: ${msg}`.trim();
    });

    type ActorTier = 'premium' | 'verified' | 'organization' | null;
    function actorTierFor(n: {
      actor?: {
        premium?: boolean | null;
        premiumPlus?: boolean | null;
        isOrganization?: boolean | null;
        verifiedStatus?: string | null;
      } | null;
    }): ActorTier {
      const a = n.actor;
      if (!a) return null;
      if (a.isOrganization) return 'organization';
      if (Boolean(a.premium || a.premiumPlus)) return 'premium';
      if ((a.verifiedStatus ?? 'none') !== 'none') return 'verified';
      return null;
    }
    function actorTierLabel(tier: ActorTier): string {
      if (tier === 'organization') return 'Organization';
      if (tier === 'premium') return 'Premium';
      if (tier === 'verified') return 'Verified';
      return '';
    }
    type PostVisibility = 'public' | 'verifiedOnly' | 'premiumOnly' | 'onlyMe';
    function postVisibilityFor(n: { subjectPost?: { visibility?: string | null } | null }): PostVisibility | null {
      const vis = n?.subjectPost?.visibility;
      if (vis === 'public' || vis === 'verifiedOnly' || vis === 'premiumOnly' || vis === 'onlyMe') return vis;
      return null;
    }
    function postVisibilityLabel(vis: PostVisibility | null): string {
      if (vis === 'verifiedOnly') return 'Verified post';
      if (vis === 'premiumOnly') return 'Premium post';
      if (vis === 'onlyMe') return 'Only me';
      return '';
    }

    const text = [
      greeting,
      '',
      hasUnreadChats ? `You have ${unreadChats} unread message${unreadChats === 1 ? '' : 's'} — ${chatUrl}` : '',
      hasHighSignalNotifs ? `Recent ${notifsNoun} — ${notificationsUrl}` : '',
      ...(hasHighSignalNotifs ? [''].concat(notifLines).concat(['']) : []),
      `Open chat: ${chatUrl}`,
      `Open notifications: ${notificationsUrl}`,
      '',
      `Manage notification settings: ${settingsUrl}`,
    ]
      .filter(Boolean)
      .join('\n');

    const convoCards = (() => {
      if (!hasUnreadChats) return '';
      return renderCard(
        [
          `<div style="margin-bottom:10px;">${renderPill('Messages', 'warning')}</div>`,
          `<div style="font-size:14px;line-height:1.8;color:${EMAIL.text};">You have <strong>${unreadChats}</strong> unread message${
            unreadChats === 1 ? '' : 's'
          }.</div>`,
          chatPreviewRows.length
            ? `<div style="margin-top:10px;font-size:13px;line-height:1.7;color:${EMAIL.muted};">Latest:</div>
<ul style="margin:8px 0 0 18px;padding:0;color:${EMAIL.text};font-size:14px;line-height:1.6;">
${chatPreviewRows
  .map(
    (r) =>
      `<li style="margin:0 0 8px 0;"><a href="${escapeHtml(r.href)}" style="color:${EMAIL.text};text-decoration:none;"><strong>${escapeHtml(
        r.sender,
      )}</strong> — ${escapeHtml(r.body)}</a></li>`,
  )
  .join('')}
</ul>`
            : ``,
          `<div style="margin-top:12px;">${renderButton({ href: chatUrl, label: 'Open chat' })}</div>`,
        ].join(''),
      );
    })();

    const notifCard = hasHighSignalNotifs
      ? renderCard(
          [
            `<div style="margin-bottom:10px;">${renderPill('Mentions & replies', 'info')}</div>`,
            `<ul style="margin:0 0 0 18px;padding:0;color:${EMAIL.text};font-size:14px;line-height:1.6;">`,
            ...notifs.slice(0, 5).map((n) => {
              const actorRealName = (n.actor?.name ?? '').trim();
              const actorUser = (n.actor?.username ?? '').trim();
              const actor = actorRealName || (actorUser ? `@${actorUser}` : 'Someone');
              const label = n.kind === 'comment' ? 'Reply' : 'Mention';
              const msg = truncate((n.body ?? n.title ?? '').trim(), 140);
              const href = n.subjectPostId ? `${baseUrl}/p/${encodeURIComponent(n.subjectPostId)}` : notificationsUrl;
              const tier = actorTierFor(n);
              const tierPill = tier ? ` <span style="display:inline-block;width:6px;"></span>${renderPill(actorTierLabel(tier), { actorTier: tier })}` : '';
              const vis = postVisibilityFor(n);
              const visPill =
                vis && vis !== 'public'
                  ? ` <span style="display:inline-block;width:6px;"></span>${renderPill(postVisibilityLabel(vis), { postVisibility: vis })}`
                  : '';
              return `<li style="margin:0 0 10px 0;"><a href="${escapeHtml(
                href,
              )}" style="color:${EMAIL.text};text-decoration:none;"><strong>${escapeHtml(label)}</strong> from <strong>${escapeHtml(
                actor,
              )}</strong>${tierPill}${visPill} — ${escapeHtml(msg)}</a></li>`;
            }),
            `</ul>`,
            `<div style="margin-top:12px;">${renderButton({ href: notificationsUrl, label: 'Open notifications', variant: 'secondary' })}</div>`,
          ].join(''),
        )
      : '';

    const previewText =
      hasUnreadChats && hasHighSignalNotifs
        ? `New messages and ${notifsNoun} waiting for you.`
        : hasUnreadChats
          ? `You have new messages waiting for you.`
          : `You have new ${notifsNoun}.`;

    const html = renderMohEmail({
      title: 'New activity',
      preheader: previewText,
      contentHtml: [
        `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:${EMAIL.text};">New activity</div>`,
        `<div style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:${EMAIL.muted};">${escapeHtml(greeting)}</div>`,
        `<div style="margin:0 0 14px 0;">${renderPill(previewText, 'neutral')}</div>`,
        convoCards,
        notifCard,
        `<div style="margin-top:14px;font-size:13px;line-height:1.8;color:${EMAIL.muted};">You can manage message, mention, and reply emails in <a href="${escapeHtml(
          settingsUrl,
        )}" style="color:${EMAIL.text};text-decoration:underline;">Settings → Notifications</a>.</div>`,
      ]
        .filter(Boolean)
        .join(''),
      footerHtml: `Manage notifications in <a href="${escapeHtml(settingsUrl)}" style="color:${EMAIL.soft};text-decoration:underline;">Settings → Notifications</a> · Men of Hunger`,
    });

    await this.support.sendEmailAndHandle({
      to,
      subject,
      text,
      html,
      userId,
      logTag: 'instant-high-signal',
      preference: 'emailInstantHighSignal',
      category: 'service',
      eventKey: `conversation:${userId}:${createHash('sha256').update(JSON.stringify([
        notifs.map(n => n.id).sort(),
        unreadConversations.map(p => [p.conversation.id, p.conversation.lastMessageAt]).sort(),
      ])).digest('hex')}`,
      onSent: async () => {
        await this.prisma.notificationPreferences.upsert({
          where: { userId },
          create: { userId, lastEmailInstantHighSignalSentAt: now },
          update: { lastEmailInstantHighSignalSentAt: now },
        });
      },
    });
    } catch (err) {
      this.logger.error(
        `[instant-high-signal] run failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  async enqueueInstantHighSignalEmail(userId: string): Promise<void> {
    const id = String(userId ?? '').trim();
    if (!id) return;
    try {
      await this.jobs.enqueueCron(
        JOBS.notificationsInstantHighSignalEmail,
        { userId: id },
        `notifications:instantHighSignalEmail:${id}`,
        {
          delay: this.INSTANT_EMAIL_DELAY_MS,
          attempts: 2,
          backoff: { type: 'exponential', delay: 60_000 },
        },
      );
    } catch {
      // likely duplicate jobId; treat as no-op (batching).
    }
  }

  // ─── Followed-author article email ────────────────────────────────────────────

  async runSendFollowedArticleEmail(data: { articleId?: string; authorUserId?: string }): Promise<void> {
    const { articleId, authorUserId } = data ?? {};
    if (!articleId || !authorUserId) {
      this.logger.warn(`[followed-article-email] missing articleId or authorUserId in job data`);
      return;
    }

    // Per-publish fan-out is disabled by default on the Resend free tier.
    // New articles appear in the weekly digest instead.
    // Enable EMAIL_FOLLOWED_ARTICLE_ENABLED=true after upgrading Resend.
    if (!this.appConfig.emailFollowedArticleEnabled()) {
      this.logger.debug(`[followed-article-email] article=${articleId} skipped (EMAIL_FOLLOWED_ARTICLE_ENABLED=false)`);
      return;
    }

    try {
      const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
      const r2PublicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
      const settingsUrl = `${baseUrl}/settings/notifications`;

      const article = await this.prisma.article.findUnique({
        where: { id: articleId },
        select: {
          id: true,
          title: true,
          body: true,
          excerpt: true,
          thumbnailR2Key: true,
          visibility: true,
          isDraft: true,
          deletedAt: true,
          author: {
            select: {
              ...USER_BRIEF_SELECT,
              bio: true,
              articleBio: true,
              avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true,
              avatarUpdatedAt: true,
              verifiedStatus: true,
              premium: true,
              premiumPlus: true,
            },
          },
        },
      });

      if (!article || article.isDraft || article.deletedAt) {
        this.logger.debug(`[followed-article-email] article ${articleId} not found or not published, skipping`);
        return;
      }

      const author = article.author;
      const authorName =
        String(author.name ?? '').trim() || String(author.username ?? '').trim() || 'Someone you follow';
      const authorAvatarUrl = publicAssetUrl({
        publicBaseUrl: r2PublicBaseUrl,
        key: author.avatarKey,
        updatedAt: author.avatarUpdatedAt,
      });
      const authorBio = (author.articleBio ?? author.bio ?? '').trim() || null;
      const authorVerified = author.verifiedStatus !== 'none';
      const authorPremium = Boolean(author.premium || author.premiumPlus);
      const authorProfileUrl = author.username ? `${baseUrl}/u/${author.username}` : baseUrl;
      const articleUrl = `${baseUrl}/a/${article.id}`;
      const articleThumbnailUrl = article.thumbnailR2Key
        ? publicAssetUrl({ publicBaseUrl: r2PublicBaseUrl, key: article.thumbnailR2Key })
        : null;

      // Pre-render the body preview once (avoids re-parsing the same JSON per follower).
      const bodyPreviewHtml = article.body
        ? renderTiptapPreviewHtml(article.body, 3, { siteUrl: baseUrl })
        : null;

      // Query all followers who have a verified email address.
      const followers = await this.prisma.follow.findMany({
        where: { followingId: authorUserId },
        select: {
          follower: {
            select: {
              id: true,
              name: true,
              username: true,
              email: true,
              emailVerifiedAt: true,
              verifiedStatus: true,
              premium: true,
              premiumPlus: true,
              notificationPreferences: {
                select: { emailFollowedArticle: true },
              },
            },
          },
        },
      });

      let sent = 0;
      let skipped = 0;

      for (const { follower } of followers) {
        if (!follower) continue;

        // Skip self-follows (shouldn't exist, but guard anyway).
        if (follower.id === authorUserId) continue;

        // Require a verified email.
        const to = getVerifiedRecipientEmail(follower);
        if (!to) { skipped++; continue; }

        // Respect the emailFollowedArticle preference (default true when no row exists).
        const prefEnabled = follower.notificationPreferences?.emailFollowedArticle ?? true;
        if (!prefEnabled) { skipped++; continue; }

        // Tier gate: match the same logic as allowedPostVisibilities.
        if (article.visibility === 'verifiedOnly') {
          if (!follower.verifiedStatus || follower.verifiedStatus === 'none') { skipped++; continue; }
        }
        if (article.visibility === 'premiumOnly') {
          if (!follower.premium && !follower.premiumPlus) { skipped++; continue; }
        }

        const recipientName =
          String(follower.name ?? '').trim() || String(follower.username ?? '').trim() || null;
        const greeting = recipientName ? `Hey ${recipientName},` : `Hey,`;

        const { subject, text, html } = buildFollowedArticleEmail({
          greeting,
          authorName,
          authorUsername: author.username,
          authorAvatarUrl,
          authorBio,
          authorVerified,
          authorPremium,
          articleUrl,
          articleTitle: article.title,
          articleBodyJson: null,
          articleBodyPreviewHtml: bodyPreviewHtml,
          articleExcerpt: article.excerpt ?? null,
          articleThumbnailUrl,
          articleVisibility: article.visibility as 'public' | 'verifiedOnly' | 'premiumOnly',
          authorProfileUrl,
          settingsUrl,
        });

        await this.support.sendEmailAndHandle({
          to,
          subject,
          text,
          html,
          userId: follower.id,
          logTag: `followed-article:${articleId}`,
          preference: 'emailFollowedArticle',
          eventKey: `article:${articleId}:${follower.id}`,
        });

        sent++;
      }

      this.logger.log(
        `[followed-article-email] article=${articleId} sent=${sent} skipped=${skipped}`,
      );
    } catch (err) {
      this.logger.error(
        `[followed-article-email] run failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}

