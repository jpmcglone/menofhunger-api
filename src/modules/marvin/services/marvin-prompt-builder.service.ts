import { Injectable } from '@nestjs/common';
import type { MarvinSource } from '@prisma/client';
import {
  MARV_CONCISENESS,
  MARV_CRISIS_SAFETY,
  MARV_DM_CONTEXT_HINT,
  MARV_NO_PROACTIVE_OFFERS,
  MARV_THREAD_TOOL_FALLBACK,
  MARV_THREAD_TOOL_OPTIONAL,
  MARV_USER_LOOKUP_HINT,
  MARV_WEB_SEARCH_REQUIRED,
} from '../marvin-prompt-instructions';

export type MarvPromptUser = {
  userId: string;
  username: string | null;
  displayName: string | null;
};

export type MarvPollOption = {
  text: string;
  voteCount: number;
};

export type MarvPoll = {
  totalVoteCount: number;
  endsAt: Date | null;
  options: MarvPollOption[];
};

export type MarvThreadPost = {
  id: string;
  authorUsername: string | null;
  authorDisplayName: string | null;
  body: string;
  createdAt: string;
  /** True when this is the post that contained the @marv mention. */
  isTriggeringPost?: boolean;
  /** True when Marv himself wrote this post. The model should treat it as its own prior reply. */
  isMarv?: boolean;
  /**
   * For check-in posts: the daily prompt the author was responding to
   * (e.g. "What are you grateful for today?").
   */
  checkinPrompt?: string | null;
  /** Poll attached to this post, if any. */
  poll?: MarvPoll | null;
};

export type MarvLinkPreview = {
  url: string;
  title?: string | null;
  description?: string | null;
  siteName?: string | null;
};

export type MarvPromptInput = {
  source: MarvinSource;
  /** The user who triggered this Marv reply (mentioned @marv in a thread, or sent a DM). */
  requester: MarvPromptUser;
  /**
   * The actual question/message Marv should answer. For public threads this is the body
   * of the post that mentions @marv. For private sessions this is the latest user message.
   */
  currentQuestion: string;
  /**
   * Public-thread context only: the originating post id (the post that contained @marv).
   * Marv can fetch MORE context via the `get_post_thread_recent_messages` tool if needed.
   */
  triggeringPostId?: string;
  /** Public-thread context only: the root post id (top of the thread). */
  rootPostId?: string;
  /**
   * Public-thread context only: recent posts from the thread (root + replies), already
   * fetched by the processor and injected here so the model never needs a tool call to
   * see basic thread context. Oldest → newest order. Capped at ~15 posts.
   *
   * Legacy flat rendering — used as a fallback when the bidirectional fields below
   * (`ancestors` / `descendants` / `triggeringPost`) are not supplied.
   */
  threadContext?: MarvThreadPost[];
  /**
   * Public-thread context: the path ABOVE the message that mentions Marv, ordered
   * root-most → immediate parent. When provided (with `triggeringPost`), the builder
   * renders a sectioned, bidirectional view instead of the flat `threadContext`.
   */
  ancestors?: MarvThreadPost[];
  /** Public-thread context: the post that actually mentions Marv. */
  triggeringPost?: MarvThreadPost;
  /**
   * Public-thread context: replies UNDER the message that mentions Marv, in reading
   * order. Lets Marv see how the conversation continued below him.
   */
  descendants?: MarvThreadPost[];
  /**
   * Public-thread context: the rolling thread summary (when the thread is long enough
   * to have one), so Marv has the gist of older posts beyond the collected window.
   */
  rollingSummary?: string | null;
  /** Private-session context only: the conversation Marv ↔ user. */
  conversationId?: string;
  /**
   * Other users referenced in the triggering content (e.g. @mentioned in the post). Surfaced
   * to the model as a hint ("these users are part of the conversation") — it can call
   * `get_user_context_card` on any non-banned user, this list is just a routing nudge.
   */
  referencedUsernames?: string[];
  /**
   * Set when the routing layer detected crisis / despair / self-harm signals. The system
   * prompt on OpenAI is general; this flag injects a per-request safety instruction.
   */
  crisisDetected?: boolean;
  /**
   * Set when the user explicitly demanded a web search (e.g. "search the web for…").
   * Injects a strong instruction so the model always calls web_search_preview.
   */
  webSearchDemanded?: boolean;
  /**
   * Link previews fetched from the LinkMetadata cache for URLs in the triggering content.
   * Rendered as a brief inline block so Marv can reference title/description without a tool call.
   */
  linkPreviews?: MarvLinkPreview[];
  /**
   * When true, at least one GIF was attached as a vision input. Injects a note telling the
   * model it is seeing a single still frame, not an animation.
   */
  hasGifAttached?: boolean;
};

export type MarvBuiltPrompt = {
  /**
   * Compact "developer" message we prepend to the user's question. The personality + tool
   * schemas live in OpenAI's stored Prompt; this is just the per-request scaffolding
   * (who's asking, where, and any safety nudges).
   */
  developerNote: string;
  /** The user's actual question, lightly trimmed. */
  userMessage: string;
};

/**
 * Builds the per-request scaffolding for a Marv call.
 *
 * The Marv "personality" (system prompt + tool schemas + voice rules) lives in an OpenAI
 * Stored Prompt — we never duplicate it here. This service produces the small developer
 * note that travels alongside the user's question (who's asking, where, thread history,
 * safety nudges).
 */
@Injectable()
export class MarvinPromptBuilderService {
  build(input: MarvPromptInput): MarvBuiltPrompt {
    const requesterDisplay =
      (input.requester.displayName ?? '').trim() ||
      (input.requester.username ?? '').trim() ||
      'a user';
    const requesterHandle = input.requester.username ? `@${input.requester.username}` : '(no username)';

    const referenced = (input.referencedUsernames ?? [])
      .map((u) => u.trim())
      .filter(Boolean);

    const lines: string[] = [];
    if (input.source === 'public_thread') {
      lines.push('Source: public post thread.');
      if (input.triggeringPostId) lines.push(`Triggering post id: ${input.triggeringPostId}.`);
      if (input.rootPostId) lines.push(`Thread root post id: ${input.rootPostId}.`);

      const hasBidirectional =
        Boolean(input.triggeringPost) ||
        (input.ancestors?.length ?? 0) > 0 ||
        (input.descendants?.length ?? 0) > 0;

      if (hasBidirectional) {
        // Sectioned, bidirectional view: what's above the mention, the mention itself,
        // and what came after it — so Marv reasons about the whole conversation.
        if (input.rollingSummary && input.rollingSummary.trim()) {
          lines.push('Thread summary so far (older posts beyond the window below):');
          lines.push(`  ${input.rollingSummary.trim().slice(0, 1500)}`);
        }
        if (input.ancestors && input.ancestors.length > 0) {
          lines.push('Path above the message that mentions you (oldest → newest):');
          for (const p of input.ancestors) lines.push(...this.renderThreadPostLines(p));
        }
        if (input.triggeringPost) {
          lines.push('The message that mentions you:');
          lines.push(...this.renderThreadPostLines({ ...input.triggeringPost, isTriggeringPost: true }));
        }
        if (input.descendants && input.descendants.length > 0) {
          lines.push('Replies under it (posted after the message that mentions you):');
          for (const p of input.descendants) lines.push(...this.renderThreadPostLines(p));
        }
        lines.push(
          'Do not repeat or paraphrase what YOU previously said. Build on it or answer the new question.',
        );
        lines.push(MARV_THREAD_TOOL_OPTIONAL + MARV_CONCISENESS);
      } else if (input.threadContext && input.threadContext.length > 0) {
        // Legacy flat rendering (oldest → newest), kept for callers that haven't moved
        // to the bidirectional fields.
        lines.push('Thread (oldest → newest):');
        for (const p of input.threadContext) lines.push(...this.renderThreadPostLines(p));
        lines.push(
          'Do not repeat or paraphrase what YOU previously said. Build on it or answer the new question.',
        );
        lines.push(MARV_THREAD_TOOL_OPTIONAL + MARV_CONCISENESS);
      } else {
        lines.push(MARV_THREAD_TOOL_FALLBACK + MARV_CONCISENESS);
      }
      lines.push('IMPORTANT: ' + MARV_NO_PROACTIVE_OFFERS);
    } else {
      lines.push('Source: private DM session with the user.');
      if (input.conversationId) lines.push(`Conversation id: ${input.conversationId}.`);
      lines.push(MARV_DM_CONTEXT_HINT + MARV_USER_LOOKUP_HINT + MARV_CONCISENESS + ' ' + MARV_NO_PROACTIVE_OFFERS);
    }

    lines.push(`Requester: ${requesterDisplay} ${requesterHandle} (id: ${input.requester.userId}).`);

    if (referenced.length > 0) {
      lines.push(
        `Other users referenced in this conversation: ${referenced.map((u) => '@' + u).join(', ')}.`,
      );
    }

    if (input.crisisDetected) {
      lines.push(MARV_CRISIS_SAFETY);
    }

    if (input.webSearchDemanded) {
      lines.push(MARV_WEB_SEARCH_REQUIRED);
    }

    if (input.hasGifAttached) {
      lines.push(
        'NOTE: One or more GIFs were attached as images. You are seeing a single still frame per GIF — describe what is visible in that frame; do not assume motion or animation.',
      );
    }

    if (input.linkPreviews && input.linkPreviews.length > 0) {
      lines.push('[Link previews from the message]');
      for (const lp of input.linkPreviews) {
        const site = lp.siteName ? ` — ${lp.siteName}` : '';
        const desc = lp.description ? ` — ${lp.description.slice(0, 120)}` : '';
        const title = lp.title ?? lp.url;
        lines.push(`  - "${title}"${site}${desc}`);
      }
    }

    return {
      developerNote: lines.join('\n'),
      userMessage: (input.currentQuestion ?? '').trim().slice(0, 4000),
    };
  }

  /** Renders one thread post (author line + optional check-in prompt + optional poll). */
  private renderThreadPostLines(p: MarvThreadPost): string[] {
    const handle = p.isMarv
      ? '[YOU previously said]'
      : p.authorUsername
        ? `@${p.authorUsername}`
        : (p.authorDisplayName ?? 'unknown');
    const tag = p.isTriggeringPost ? ' [← this message mentions you]' : '';
    const out: string[] = [];
    if (p.checkinPrompt) {
      out.push(`  [Daily check-in prompt]: "${p.checkinPrompt.slice(0, 300)}"`);
    }
    out.push(`  ${handle}${tag}: "${p.body.slice(0, 500)}"`);
    if (p.poll) {
      out.push(MarvinPromptBuilderService.renderPoll(p.poll));
    }
    return out;
  }

  /** Renders a poll as a compact inline text block for the developer note. */
  private static renderPoll(poll: MarvPoll): string {
    const total = poll.totalVoteCount;
    const closeStr = poll.endsAt
      ? `closes ${poll.endsAt.toUTCString()}`
      : 'no close date';
    const optionLines = poll.options.map((o) => {
      const pct = total > 0 ? Math.round((o.voteCount / total) * 100) : 0;
      return `    - "${o.text}" — ${o.voteCount} (${pct}%)`;
    });
    return `  [Poll on this post] (${total} vote${total !== 1 ? 's' : ''}, ${closeStr})\n${optionLines.join('\n')}`;
  }
}
