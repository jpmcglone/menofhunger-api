import { Injectable } from '@nestjs/common';
import type { MarvinSource } from '@prisma/client';
import {
  MARV_CONCISENESS,
  MARV_CRISIS_SAFETY,
  MARV_DM_CONTEXT_HINT,
  MARV_NO_PROACTIVE_OFFERS,
  MARV_THREAD_TOOL_FALLBACK,
  MARV_THREAD_TOOL_OPTIONAL,
  MARV_WEB_SEARCH_REQUIRED,
} from '../marvin-prompt-instructions';

export type MarvPromptUser = {
  userId: string;
  username: string | null;
  displayName: string | null;
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
   */
  threadContext?: MarvThreadPost[];
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

      // Inline thread context so the model always sees it — no tool call required.
      if (input.threadContext && input.threadContext.length > 0) {
        lines.push('Thread (oldest → newest):');
        for (const p of input.threadContext) {
          const handle = p.isMarv
            ? '[YOU previously said]'
            : p.authorUsername
              ? `@${p.authorUsername}`
              : (p.authorDisplayName ?? 'unknown');
          const tag = p.isTriggeringPost ? ' [← this message mentions you]' : '';
          if (p.checkinPrompt) {
            lines.push(`  [Daily check-in prompt]: "${p.checkinPrompt.slice(0, 300)}"`);
          }
          lines.push(`  ${handle}${tag}: "${p.body.slice(0, 500)}"`);
        }
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
      lines.push(MARV_DM_CONTEXT_HINT + MARV_CONCISENESS + ' ' + MARV_NO_PROACTIVE_OFFERS);
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

    return {
      developerNote: lines.join('\n'),
      userMessage: (input.currentQuestion ?? '').trim().slice(0, 4000),
    };
  }
}
