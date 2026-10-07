import { Injectable } from '@nestjs/common';
import { choice, noul } from '@typesafe-ai/sdk';
import { AppConfigService } from '../../app/app-config.service';
import { TypeSafeService } from '../../typesafe/typesafe.service';

/** Routing and reply gating sit on the request path, so they get a short budget and then fall back to rules. */
const JEV_BUDGET_MS = 3_000;
const MAX_TEXT_CHARS = 6_000;

export type JevRoutingSignals = {
  /** Probability the author expresses suicidal thoughts, self-harm, or severe despair. */
  crisis: number;
  /** Probability the topic needs careful pastoral, doctrinal, or heated-debate handling. */
  sensitive: number;
  /** Probability the author directly asks Marv to look something up online. Null when web search is off. */
  explicitSearch: number | null;
  /** Probability a good answer needs current or real-time information. Null when web search is off. */
  liveInfo: number | null;
  /**
   * Probability this is a task weaker models systematically miss (letter counts, exact
   * spelling, lookalike numbers) even though a person finds it easy. Independent of
   * {@link complexity}, which treats these as simple.
   */
  modelTrap: number;
  /** Probability the author is correcting or rejecting a previous answer, especially Marv's. */
  pushback: number;
  complexity: { level: 'simple' | 'moderate' | 'complex'; confidence: number };
};

/**
 * Jev-backed decisions for Marv. Every method returns null when Jev is off, slow, or failing, and
 * callers must then behave exactly as they did before Jev existed.
 */
@Injectable()
export class MarvinJevService {
  constructor(
    private readonly typeSafe: TypeSafeService,
    private readonly appConfig: AppConfigService,
  ) {}

  routingAvailable(): boolean {
    return this.typeSafe.isConfigured() && this.appConfig.typeSafe().routingEnabled;
  }

  replyGateAvailable(): boolean {
    return this.typeSafe.isConfigured() && this.appConfig.typeSafe().replyGateEnabled;
  }

  async routingSignals(args: {
    text: string;
    webSearchEnabled: boolean;
    replyingTo?: { text: string; fromMarv: boolean } | null;
  }): Promise<JevRoutingSignals | null> {
    const message = args.text.trim();
    if (!message || !this.routingAvailable()) return null;

    const previous = args.replyingTo?.text.trim();
    const result = await this.typeSafe.decide({
      purpose: 'marv.routing',
      timeoutMs: JEV_BUDGET_MS,
      signal: AbortSignal.timeout(JEV_BUDGET_MS),
      state: {
        message: message.slice(0, MAX_TEXT_CHARS),
        ...(previous
          ? {
              previousMessage: previous.slice(0, 1_500),
              previousAuthor: args.replyingTo?.fromMarv ? 'Marv' : 'another member',
            }
          : {}),
      },
      questions: {
        crisis: noul(
          'Does the author express suicidal thoughts, a wish to die, self-harm, or severe hopelessness about going on living?',
          {
            true: 'Suicidal ideation, self-harm, or overwhelming despair about continuing to live.',
            false: 'Ordinary conversation, including normal sadness, frustration, or joking figures of speech.',
          },
        ),
        sensitive: noul(
          'Is this a sensitive subject needing careful, pastoral or doctrinal handling: disputes over theology or scripture interpretation, marriage or family conflict, abuse, pornography or addiction struggles, abortion or gender and other heated cultural or political debate, or fact-checking a serious claim?',
          {
            true: 'A weighty personal, moral, doctrinal, or contested subject where a careless answer could hurt or mislead.',
            false: 'A light, practical, or low-stakes question or comment.',
          },
        ),
        explicitSearch: noul(
          'Is the author directly asking to search the web or look something up online?',
          { true: 'Explicit request to search, google, or look it up.', false: 'No explicit request to search.' },
        ),
        liveInfo: noul(
          'Would a good answer require current or real-time information, such as news, scores, prices, weather, or recent events?',
          { true: 'Depends on facts that change over time or happened recently.', false: 'Answerable from stable knowledge or reasoning.' },
        ),
        modelTrap: noul(
          'Is this a task weaker language models systematically get wrong, even though a person finds it easy? Count specific letters or characters in a word, spell or reverse a word exactly, repeat a phrase an exact number of times, or compare lookalike numbers such as 9.11 and 9.9. Ordinary counting of people or things, riddles, and hard reasoning do not count.',
          {
            true: 'A precise character, spelling, repetition, or lookalike-number task that models often miss.',
            false: 'Any other message, including casual chat, real counting questions, riddles, and difficult reasoning.',
          },
        ),
        pushback: noul(
          'Is the author correcting, rejecting, or challenging a previous answer, especially one Marv just gave? Use previousMessage when it is present. A new question, a thanks, or agreement is not pushback.',
          {
            true: 'A clear correction or "that is wrong" aimed at the prior answer.',
            false: 'A new request, thanks, agreement, or a mild aside that does not reject the prior answer.',
          },
        ),
        complexity: choice('How demanding is it to answer this message well?', {
          simple: 'A brief direct answer, casual exchange, or a well-known fact or opinion.',
          moderate: 'Needs a multi-part explanation, comparison, careful drafting, or some synthesis.',
          complex: 'Needs deep multi-step reasoning, nuanced analysis, or carries high stakes for the author.',
        }),
      },
    });
    if (!result) return null;

    const { answers } = result;
    return {
      crisis: answers.crisis.noul,
      sensitive: answers.sensitive.noul,
      explicitSearch: args.webSearchEnabled ? answers.explicitSearch.noul : null,
      liveInfo: args.webSearchEnabled ? answers.liveInfo.noul : null,
      modelTrap: answers.modelTrap.noul,
      pushback: answers.pushback.noul,
      complexity: { level: answers.complexity.choice, confidence: answers.complexity.confidence },
    };
  }

  /**
   * Probability that the author expects Marv to answer. Low means the mention is a thanks, praise,
   * reaction, or passing reference. Null means no opinion (Jev unavailable): reply as usual.
   */
  async replyExpectedProbability(args: {
    text: string;
    /** The message being replied to, when there is one. */
    previous?: { text: string; fromMarv: boolean } | null;
  }): Promise<number | null> {
    const message = args.text.trim();
    if (!message || !this.replyGateAvailable()) return null;

    const result = await this.typeSafe.decide({
      purpose: 'marv.reply-gate',
      timeoutMs: JEV_BUDGET_MS,
      signal: AbortSignal.timeout(JEV_BUDGET_MS),
      state: {
        message: message.slice(0, MAX_TEXT_CHARS),
        ...(args.previous
          ? {
              replyingTo: args.previous.text.slice(0, 1_500),
              replyingToAuthor: args.previous.fromMarv ? 'Marv' : 'another member',
            }
          : {}),
      },
      questions: {
        replyExpected: noul(
          'The author mentioned Marv, an assistant, in this message. Does the author expect Marv to reply with something substantive? Answering a question Marv asked, accepting an offer from Marv ("yes please"), or asking for more all count as expecting a reply.',
          {
            true: 'A question, request, task, challenge, answer to Marv, or invitation for Marv to weigh in.',
            false: 'A pure acknowledgment, thanks, praise, laugh, or reaction, or a passing reference to Marv that asks for nothing.',
          },
        ),
      },
    });
    return result ? result.answers.replyExpected.noul : null;
  }
}
