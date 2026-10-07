import { Injectable } from '@nestjs/common';
import { noul } from '@typesafe-ai/sdk';
import { AppConfigService } from '../../app/app-config.service';
import { TypeSafeService } from '../../typesafe/typesafe.service';

const JEV_BUDGET_MS = 3_000;
const MAX_TEXT_CHARS = 2_000;
/** Jev must be at least this sure the author is talking to Marv before an untagged post summons him. */
export const ADDRESSED_TO_MARV_THRESHOLD = 0.5;
/** A real person named Marv is in the conversation, so a bare name needs far more certainty. */
export const ADDRESSED_TO_MARV_THRESHOLD_WITH_NAMESAKE = 0.8;

export function isAddressedToMarv(probability: number | null, otherMarvs: string[]): boolean {
  if (probability === null) return false;
  return probability >= (otherMarvs.length ? ADDRESSED_TO_MARV_THRESHOLD_WITH_NAMESAKE : ADDRESSED_TO_MARV_THRESHOLD);
}

const NAME_PATTERN = /(^|[^@\w])marv\b/i;

export type MarvAddressingParent = {
  text: string;
  authorIsMarv: boolean;
  authorIsSpeaker: boolean;
};

/**
 * Decides whether an untagged post is speaking to Marv. Only posts that could plausibly be (a reply
 * to Marv, or the word "Marv" without an @) are ever sent to Jev. Null means no opinion, and the
 * caller keeps the old rule that only an explicit @mention summons him.
 */
@Injectable()
export class MarvinAddressingService {
  constructor(
    private readonly typeSafe: TypeSafeService,
    private readonly appConfig: AppConfigService,
  ) {}

  available(): boolean {
    return this.typeSafe.isConfigured() && this.appConfig.typeSafe().addressingEnabled;
  }

  /** True for members whose handle or display name looks like "Marv": a different person from the bot. */
  static namedLikeMarv(member: { username?: string | null; name?: string | null }): boolean {
    return /marv/i.test(member.username ?? '') || /marv/i.test(member.name ?? '');
  }

  /** Cheap pre-filter so ordinary posts never reach Jev. */
  static isCandidate(text: string, parentIsMarv: boolean): boolean {
    return parentIsMarv || NAME_PATTERN.test(text);
  }

  async addressedToMarvProbability(args: {
    text: string;
    parent?: MarvAddressingParent | null;
    /** Other members here whose name looks like "Marv". Lets Jev tell the bot from a person. */
    otherMarvs?: string[];
  }): Promise<number | null> {
    const message = args.text.trim();
    if (!message || !this.available()) return null;
    const parent = args.parent ?? null;

    const result = await this.typeSafe.decide({
      purpose: 'marv.addressing',
      timeoutMs: JEV_BUDGET_MS,
      signal: AbortSignal.timeout(JEV_BUDGET_MS),
      state: {
        message: message.slice(0, MAX_TEXT_CHARS),
        ...(parent
          ? {
              replyingTo: parent.text.slice(0, 1_500),
              replyingToAuthor: parent.authorIsMarv
                ? 'Marv, the AI assistant'
                : parent.authorIsSpeaker
                  ? 'the same person writing this message'
                  : 'another member',
            }
          : { replyingToAuthor: 'nobody: this is a new post' }),
        otherMembersNamedMarv: args.otherMarvs?.length ? args.otherMarvs.slice(0, 5).join(', ') : 'none: the assistant is the only Marv here',
      },
      questions: {
        addressedToMarv: noul(
          'Marv is an AI assistant on a social network. Is the author speaking directly to Marv and expecting him to answer? Use the replyingToAuthor field: when it is Marv, an untagged "you" or a follow-up question almost certainly means Marv, since nobody else is being addressed. When it is another member, or this is a new post, "you" means someone else, so only the name "Marv" used as a direct address counts. Calling him by name to greet him, ask something, or check he is there ("hey marv are you there?", "MARV where are you") is addressing him, even without a question mark and even when it replies to a post by another member, as long as no other member of the conversation is named Marv. Talking about Marv in the third person never counts. If otherMembersNamedMarv is present, those are real people in this conversation, so a bare "Marv" may mean one of them: only count it when the message plainly addresses the assistant (for example it asks something an assistant would answer, or replies to the assistant).',
          {
            true: 'Calls Marv by name, or asks, tells, thanks, or answers him directly, such as a reply to Marv saying "you", a follow-up to his answer, "hey marv are you there?", or "Marv, what do you think?".',
            false: 'Speaks to someone else, or merely talks about Marv ("Marv got that wrong", "I asked Marv yesterday"), or does not need an answer.',
          },
        ),
      },
    });
    return result ? result.answers.addressedToMarv.noul : null;
  }
}
