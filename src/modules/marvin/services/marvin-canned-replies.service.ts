import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../app/app-config.service';
import { PostsService } from '../../posts/posts.service';
import { MessagesService } from '../../messages/messages.service';
import { MarvinBotIdentityService } from './marvin-bot-identity.service';
import { MarvinCreditService } from './marvin-credit.service';
import { MarvinNonPremiumRepliesService } from './marvin-non-premium-replies.service';

const TIERS_PATH = '/tiers';

/**
 * Builds + posts the non-AI replies Marv produces for hard error states. All flows
 * here skip OpenAI entirely and have zero AI cost.
 *
 * 1. **Non-premium user mentions @marv in a thread** → Marv posts a single canned reply
 *    in that thread linking to /tiers. Recorded in `MarvinNonPremiumThreadReply` with
 *    `reason: 'not_premium'` so we never re-send for the same `(user, rootPostId, reason)`.
 *
 * 2. **Premium user is out of credits** → Marv DMs the user (creating the conversation
 *    if needed) explaining they're out of credits with a refill ETA + post link.
 *    Replies on every user message (no DM-side dedup). BullMQ provides per-messageId
 *    idempotency via the stable jobId, so we never reply twice for the same message.
 *
 * 3. **Premium user mentions @marv but the AI agent isn't configured** (e.g. missing
 *    `OPENAI_API_KEY`) → in public threads, Marv replies once per `(user, rootPostId)`
 *    via the `ai_not_configured` reason; in DMs, Marv replies on every user message
 *    so the user can't miss the explanation. Without this, the request would silently
 *    no-op and the user would think Marv was ignoring them.
 */
@Injectable()
export class MarvinCannedRepliesService {
  private readonly logger = new Logger(MarvinCannedRepliesService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly identity: MarvinBotIdentityService,
    private readonly posts: PostsService,
    private readonly messages: MessagesService,
    private readonly nonPremium: MarvinNonPremiumRepliesService,
    private readonly credits: MarvinCreditService,
  ) {}

  private siteBaseUrl(): string {
    return (this.appConfig.frontendBaseUrl() ?? '').replace(/\/+$/, '');
  }

  private tiersUrl(): string {
    const base = this.siteBaseUrl();
    return base ? `${base}${TIERS_PATH}` : TIERS_PATH;
  }

  private postUrl(postId: string): string {
    const base = this.siteBaseUrl();
    return base ? `${base}/p/${postId}` : `/p/${postId}`;
  }

  /**
   * Post the "premium-only" canned reply once per (user, rootPostId). Returns the
   * marv post id on success, or null when the slot was already claimed (no-op).
   */
  async sendNonPremiumThreadReply(args: {
    requestingUserId: string;
    triggeringPostId: string;
    rootPostId: string;
  }): Promise<string | null> {
    return this.postCannedThreadReply({
      requestingUserId: args.requestingUserId,
      triggeringPostId: args.triggeringPostId,
      rootPostId: args.rootPostId,
      reason: 'not_premium',
      body: `I only reply for premium members right now. You can upgrade here: ${this.tiersUrl()}`,
    });
  }

  /**
   * Post the "AI not configured" canned reply once per (user, rootPostId). For
   * premium users who would normally get a Marv reply but the agent can't actually
   * produce one because the OpenAI client is missing required configuration.
   */
  async sendNotConfiguredThreadReply(args: {
    requestingUserId: string;
    triggeringPostId: string;
    rootPostId: string;
  }): Promise<string | null> {
    return this.postCannedThreadReply({
      requestingUserId: args.requestingUserId,
      triggeringPostId: args.triggeringPostId,
      rootPostId: args.rootPostId,
      reason: 'ai_not_configured',
      body:
        "I'd love to help, but I'm not fully set up yet. A site administrator can finish configuring me — try again soon.",
    });
  }

  /** Shared writer for all thread canned replies (deduped per user+root+reason). */
  private async postCannedThreadReply(args: {
    requestingUserId: string;
    triggeringPostId: string;
    rootPostId: string;
    reason: 'not_premium' | 'ai_not_configured' | 'transient_error';
    body: string;
  }): Promise<string | null> {
    const claimed = await this.nonPremium.tryClaim({
      userId: args.requestingUserId,
      rootPostId: args.rootPostId,
      reason: args.reason,
    });
    if (!claimed) {
      this.logger.debug(
        `[marv] Canned thread reply already sent for user=${args.requestingUserId} root=${args.rootPostId} reason=${args.reason}; skipping.`,
      );
      return null;
    }

    const marvId = await this.identity.getMarvUserId();
    if (!marvId) {
      this.logger.warn(
        `[marv] Cannot send canned thread reply (reason=${args.reason}) — Marv user not resolved.`,
      );
      return null;
    }

    try {
      const result = await this.posts.createPost({
        userId: marvId,
        body: args.body,
        // Visibility is overridden by createPost to match the parent's visibility.
        visibility: 'public',
        parentId: args.triggeringPostId,
        media: [],
        poll: null,
      });
      const postId = result.post?.id ?? null;
      if (postId) {
        await this.nonPremium.setMarvPostId({
          userId: args.requestingUserId,
          rootPostId: args.rootPostId,
          reason: args.reason,
          marvinPostId: postId,
        });
      }
      this.logger.log(
        `[marv-canned] thread reply POSTED reason=${args.reason} user=${args.requestingUserId} root=${args.rootPostId} parent=${args.triggeringPostId} reply=${postId}`,
      );
      return postId;
    } catch (err) {
      this.logger.error(
        `[marv-canned] thread reply FAILED reason=${args.reason}: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return null;
    }
  }

  /**
   * DM the user that they're out of credits. Includes a relative refill ETA and (when
   * available) a link to the post that triggered Marv. Idempotent only at the message
   * layer; the caller should rate-limit calls (e.g. once per attempt).
   */
  async sendOutOfCreditsDm(args: {
    userId: string;
    currentCredits: number;
    requiredCredits: number;
    triggeringPostId?: string | null;
  }): Promise<{ conversationId: string | null; messageId: string | null }> {
    const marvId = await this.identity.getMarvUserId();
    if (!marvId) {
      this.logger.warn('[marv] Cannot send out-of-credits DM — Marv user not resolved.');
      return { conversationId: null, messageId: null };
    }
    if (args.userId === marvId) {
      return { conversationId: null, messageId: null };
    }

    const eta = this.credits.msUntilCredits(args.currentCredits, args.requiredCredits);
    const etaText = MarvinCreditService.humanizeMs(eta);
    const lines = [
      `You're out of Marv credits — I'd reply, but I can't right now.`,
      `Credits refill over time; you'll have enough again in about ${etaText}.`,
      `Or upgrade for more headroom: ${this.tiersUrl()}.`,
    ];
    if (args.triggeringPostId) {
      lines.push(`The thread you mentioned me in: ${this.postUrl(args.triggeringPostId)}`);
    }
    const body = lines.join('\n');

    try {
      const result = await this.messages.sendBotDirectMessage({
        botUserId: marvId,
        recipientUserId: args.userId,
        body,
        media: [],
      });
      if (!result) {
        this.logger.warn(
          `[marv-canned] out-of-credits DM returned null user=${args.userId} (sendBotDirectMessage refused — sender==recipient or empty body).`,
        );
        return { conversationId: null, messageId: null };
      }
      this.logger.log(
        `[marv-canned] out-of-credits DM SENT user=${args.userId} convo=${result.conversationId} msg=${result.message?.id ?? '?'}`,
      );
      return { conversationId: result.conversationId, messageId: result.message?.id ?? null };
    } catch (err) {
      this.logger.error(
        `[marv-canned] out-of-credits DM FAILED: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return { conversationId: null, messageId: null };
    }
  }

  /**
   * DM the user that Marv hit a transient error and they should try again.
   * Sent when the AI call returned no text (e.g. max_output_tokens exhausted
   * after retry, or an unexpected empty completion) so the user isn't left
   * in silence. No dedup — each failed attempt gets its own message.
   */
  async sendTransientErrorDm(args: {
    userId: string;
  }): Promise<void> {
    const marvId = await this.identity.getMarvUserId();
    if (!marvId || args.userId === marvId) return;

    const body = "Something went sideways on my end — give it another shot in a moment.";
    try {
      const result = await this.messages.sendBotDirectMessage({
        botUserId: marvId,
        recipientUserId: args.userId,
        body,
        media: [],
      });
      this.logger.log(
        `[marv-canned] transient-error DM SENT user=${args.userId} msg=${result?.message?.id ?? '?'}`,
      );
    } catch (err) {
      this.logger.error(
        `[marv-canned] transient-error DM FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Post a transient-error reply in the thread when the AI call returned no text.
   * Deduplicated once per (user, rootPostId) so the user sees at most one
   * "try again" notice per thread, no matter how many attempts fail.
   */
  async sendTransientErrorThreadReply(args: {
    requestingUserId: string;
    triggeringPostId: string;
    rootPostId: string;
  }): Promise<string | null> {
    return this.postCannedThreadReply({
      requestingUserId: args.requestingUserId,
      triggeringPostId: args.triggeringPostId,
      rootPostId: args.rootPostId,
      reason: 'transient_error',
      body: "Something went sideways on my end — give it another shot in a moment.",
    });
  }

  /**
   * DM the user that Marv isn't configured yet (premium, in a private conversation
   * with Marv, but `OPENAI_API_KEY` etc. is missing).
   *
   * **Replies on every user message.** Unlike the public-thread variants (which
   * dedup per-user-per-thread to avoid spam), DMs are 1:1 and the user has the
   * full conversation in front of them — a single canned line buried 8 messages
   * up is easy to miss and looks like Marv is just ignoring them. BullMQ already
   * gives us per-messageId idempotency via the stable `marv-private-${id}` jobId,
   * so we don't need a second layer here.
   */
  async sendNotConfiguredDm(args: {
    userId: string;
    conversationId: string;
  }): Promise<{ conversationId: string | null; messageId: string | null }> {
    const marvId = await this.identity.getMarvUserId();
    if (!marvId) {
      this.logger.warn('[marv-canned] not-configured DM SKIPPED — Marv user not resolved.');
      return { conversationId: null, messageId: null };
    }
    if (args.userId === marvId) {
      return { conversationId: null, messageId: null };
    }

    const body =
      "I'd love to help, but I'm not fully set up yet. A site administrator can finish configuring me — try again soon.";

    try {
      const result = await this.messages.sendBotDirectMessage({
        botUserId: marvId,
        recipientUserId: args.userId,
        body,
        media: [],
      });
      if (!result) {
        this.logger.warn(
          `[marv-canned] not-configured DM returned null user=${args.userId} (sendBotDirectMessage refused).`,
        );
        return { conversationId: null, messageId: null };
      }
      this.logger.log(
        `[marv-canned] not-configured DM SENT user=${args.userId} convo=${result.conversationId} msg=${result.message?.id ?? '?'}`,
      );
      return { conversationId: result.conversationId, messageId: result.message?.id ?? null };
    } catch (err) {
      this.logger.error(
        `[marv-canned] not-configured DM FAILED: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return { conversationId: null, messageId: null };
    }
  }
}
