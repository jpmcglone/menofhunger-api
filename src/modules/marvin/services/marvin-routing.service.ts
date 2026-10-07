import { Injectable, Logger, Optional } from '@nestjs/common';
import type { MarvinSource } from '@prisma/client';
import { MarvinJevService, type JevRoutingSignals } from './marvin-jev.service';

/** Resolved mode — always one of the three real tiers, never 'auto'. */
export type ResolvedMarvinMode = 'fast' | 'regular' | 'smart';

export type MarvinRouteArgs = {
  /**
   * The user's requested tier. `'auto'` means "let the router decide from scratch" —
   * routing starts from fast and upgrades based on content signals.
   */
  requested: 'auto' | 'fast' | 'regular' | 'smart';
  source: MarvinSource;
  /** Approximate prompt length (rough char/4 heuristic is fine — we don't tokenize here). */
  estimatedInputTokens: number;
  /** The user's prompt + (optionally) a thread snippet — matched against sensitive-topic regex. */
  text: string;
  /** Number of distinct authors the model will need to reason about (multi-user threads). */
  distinctAuthors?: number;
  /** When true, web search is available at Regular/Smart; time-sensitive queries upgrade Fast→Regular. */
  webSearchEnabled?: boolean;
};

export type MarvinRouteResult = {
  mode: ResolvedMarvinMode;
  /** A trailing `+jev` means Jev changed the outcome compared with the rules alone. */
  reason: string;
  crisisDetected: boolean;
  webSearchDemanded: boolean;
  /** `jev` when Jev answered this request, `rules` when only the built-in rules ran. */
  engine: 'jev' | 'rules';
};

type RouteSignals = {
  crisis: boolean;
  sensitive: boolean;
  explicitSearch: boolean;
  webSearchSignal: boolean;
  /** Content-derived upgrade, only ever set from Jev. */
  complexity: 'moderate' | 'complex' | null;
};

/** Crisis is deliberately over-triggered: a missed signal costs far more than an extra Smart reply. */
const JEV_CRISIS_THRESHOLD = 0.35;
/** Outside this band Jev overrides the keyword rules; inside it Jev is unsure and the rules decide. */
const JEV_CONFIDENT_HIGH = 0.8;
const JEV_CONFIDENT_LOW = 0.2;
const JEV_MODERATE_CONFIDENCE = 0.7;
const JEV_COMPLEX_CONFIDENCE = 0.8;

/**
 * Picks the effective Marv model tier (Fast / Regular / Smart) for a single request.
 *
 * Rules (mirror the spec):
 *  - Smart is never auto-downgraded.
 *  - Fast/Regular auto-upgrade to Smart for sensitive or complex topics.
 *  - Fast/Regular auto-upgrade to Smart when context is very long.
 *  - Despair / self-harm signals always force Smart (and the caller should also
 *    surface a "consider seeking proper help" nudge — handled in the prompt builder).
 */
@Injectable()
export class MarvinRoutingService {
  private readonly logger = new Logger(MarvinRoutingService.name);

  constructor(@Optional() private readonly jev?: MarvinJevService) {}

  /** Threshold above which we pick at least Regular. */
  static readonly REGULAR_TOKEN_THRESHOLD = 2_000;
  /** Threshold above which we pick Smart. */
  static readonly SMART_TOKEN_THRESHOLD = 6_000;

  /**
   * Explicit web-search demand. These fire when the user is directly asking Marv to
   * look something up online. Upgrades Fast → Regular AND sets `webSearchDemanded=true`
   * so the prompt builder injects a "you MUST use web_search" instruction.
   */
  private static readonly EXPLICIT_SEARCH_PATTERNS: ReadonlyArray<RegExp> = [
    /\b(search\s+(the\s+web|online|google|internet)\s+(for)?)\b/i,
    /\b(do\s+a\s+(web|google|online)\s+search)\b/i,
    /\b(look\s+(it|this|that)\s+up\s+(online|on\s+the\s+web)?)\b/i,
    /\bcan\s+you\s+(search|google|look\s+up)\b/i,
    /\b(google|bing)\s+\w/i,
    /\b(search\s+for\s+me)\b/i,
  ];

  /**
   * Time-sensitive / current-events patterns. These upgrade Fast → Regular so the model
   * has access to web search. They do NOT force Smart — a short news summary is fine at Regular.
   */
  private static readonly WEB_SEARCH_PATTERNS: ReadonlyArray<RegExp> = [
    // Explicit news / current events
    /\b(news|headlines|breaking)\b/i,
    /\b(what('?s|\s+is)\s+(in\s+the\s+news|happening|going\s+on))\b/i,
    /\bcurrent\s+events?\b/i,
    // Time anchors that imply live data
    /\b(today|tonight|this\s+(morning|afternoon|evening|week|weekend|month|year))\b/i,
    /\b(right\s+now|at\s+the\s+moment|currently|latest|recent(ly)?)\b/i,
    /\b(yesterday|last\s+(night|week|month))\b/i,
    // Search intent
    /\b(look\s+(it|this|that)\s+up|search\s+(the\s+web|online|for)|google\s+(it|this|that)?)\b/i,
    /\bcan\s+you\s+(find|look\s+up|search)\b/i,
    // Date/time queries
    /\bwhat\s+(time|date|day)\s+(is|was)\s+it\b/i,
    /\b(when\s+(did|does|is|was|will))\b/i,
    // Sports / stock / weather live data
    /\b(score|standings|stock\s+price|weather|forecast)\b/i,
  ];

  /**
   * Sensitive topics that should force Smart.
   * Patterns are intentionally simple — false positives just bias toward more careful answers,
   * which is the "safer" failure mode.
   */
  private static readonly SMART_TOPIC_PATTERNS: ReadonlyArray<RegExp> = [
    // Theology / scripture interpretation debates
    /\b(theolog\w*|reformed|calvinis\w+|arminian|sola\s+scriptura|trinity|atonement|eschatolog\w+|paedo|credo|(?:infant\s+)?baptis\w*)\b/i,
    // Marriage / family conflict
    /\b(divorce|separation|abus\w+|adulter\w+|cheat\w+|infidelity)\b/i,
    /\b(my\s+(wife|husband|spouse)\s+(left|cheated|hit|hates))\b/i,
    // Porn / addiction / shame
    /\b(porn(ography)?|addict(ed|ion)?|relapse|sober(?:ing)?|withdraw\w*|overdos\w+)\b/i,
    /\b(masturbat\w+|lust|shame\s+spiral)\b/i,
    // Heated political / cultural debate
    /\b(abortion|trans(gender)?|gender\s+identity|woke\w*|lgbt|christian\s+nationalism)\b/i,
    // Fact-checking serious claims
    /\bfact[-\s]?check\b/i,
    /\b(is\s+it\s+(true|false)\s+that)\b/i,
  ];

  /**
   * Crisis / despair / self-harm patterns. These force Smart AND set a flag the prompt
   * builder uses to add a "encourage seeking proper help" instruction.
   */
  private static readonly CRISIS_PATTERNS: ReadonlyArray<RegExp> = [
    /\b(suicid\w+|kill\s+myself|end\s+it\s+all|end\s+my\s+life|don'?t\s+want\s+to\s+live)\b/i,
    /\b(self[-\s]?harm|cut\s+myself|hurt\s+myself)\b/i,
    /\b(no\s+reason\s+to\s+(live|exist|go\s+on))\b/i,
    /\b(want\s+to\s+die)\b/i,
  ];

  /**
   * Resolve the effective mode given the user's selection plus the request shape.
   * Returns both the effective mode and a short human-readable reason (logged + stored
   * in `MarvinUsageEvent.routingReason` for analytics).
   *
   * Jev reads the message when available; keyword rules remain the fallback when it is off,
   * slow, or unsure, and they stay a floor for crisis detection.
   */
  async resolve(args: MarvinRouteArgs): Promise<MarvinRouteResult> {
    const rules = this.resolveRules(args);
    const jev = this.jev;
    if (!jev || !jev.routingAvailable()) return rules;

    const signals = await jev.routingSignals({
      text: args.text ?? '',
      webSearchEnabled: Boolean(args.webSearchEnabled),
    });
    if (!signals) return rules;

    const merged = this.decide(args, this.mergeSignals(this.ruleSignals(args), signals));
    const changed =
      merged.mode !== rules.mode ||
      merged.crisisDetected !== rules.crisisDetected ||
      merged.webSearchDemanded !== rules.webSearchDemanded;
    if (changed) {
      this.logger.log(`[marv-routing] jev changed outcome rules=${rules.mode}/${rules.reason} jev=${merged.mode}/${merged.reason}`);
    }
    return { ...merged, reason: changed ? `${merged.reason}+jev` : merged.reason, engine: 'jev' };
  }

  /** Keyword-only routing. Deterministic; used as the fallback and the baseline Jev is compared with. */
  resolveRules(args: MarvinRouteArgs): MarvinRouteResult {
    return this.decide(args, this.ruleSignals(args));
  }

  private ruleSignals(args: MarvinRouteArgs): RouteSignals {
    const text = args.text ?? '';
    const explicitSearch = args.webSearchEnabled
      ? MarvinRoutingService.EXPLICIT_SEARCH_PATTERNS.some((re) => re.test(text))
      : false;
    return {
      crisis: MarvinRoutingService.CRISIS_PATTERNS.some((re) => re.test(text)),
      sensitive: MarvinRoutingService.SMART_TOPIC_PATTERNS.some((re) => re.test(text)),
      explicitSearch,
      webSearchSignal: args.webSearchEnabled && !explicitSearch
        ? MarvinRoutingService.WEB_SEARCH_PATTERNS.some((re) => re.test(text))
        : false,
      complexity: null,
    };
  }

  private mergeSignals(rules: RouteSignals, jev: JevRoutingSignals): RouteSignals {
    // Where Jev is confident it wins; in the uncertain middle the keyword rules decide.
    const confident = (p: number | null, fallback: boolean): boolean => {
      if (p === null) return fallback;
      if (p >= JEV_CONFIDENT_HIGH) return true;
      if (p <= JEV_CONFIDENT_LOW) return false;
      return fallback;
    };
    const explicitSearch = confident(jev.explicitSearch, rules.explicitSearch);
    const liveInfo = confident(jev.liveInfo, rules.webSearchSignal || rules.explicitSearch);
    const complexity =
      jev.complexity.level === 'complex' && jev.complexity.confidence >= JEV_COMPLEX_CONFIDENCE ? 'complex'
        : jev.complexity.level === 'moderate' && jev.complexity.confidence >= JEV_MODERATE_CONFIDENCE ? 'moderate'
          : null;
    return {
      // Never lose a keyword hit for crisis; Jev can only add to it.
      crisis: rules.crisis || jev.crisis >= JEV_CRISIS_THRESHOLD,
      sensitive: confident(jev.sensitive, rules.sensitive),
      explicitSearch,
      webSearchSignal: !explicitSearch && liveInfo,
      complexity,
    };
  }

  private decide(args: MarvinRouteArgs, signals: RouteSignals): MarvinRouteResult {
    const distinctAuthors = Math.max(0, args.distinctAuthors ?? 0);
    const { crisis: crisisDetected, sensitive: sensitiveDetected, explicitSearch, webSearchSignal } = signals;
    const done = (
      mode: ResolvedMarvinMode,
      reason: string,
      webSearchDemanded: boolean,
    ): MarvinRouteResult => ({ mode, reason, crisisDetected, webSearchDemanded, engine: 'rules' });

    // 'auto' is treated as a routing hint to start from 'fast' and upgrade as needed —
    // same as if the user picked fast but with full upgrade eligibility.
    const baseMode: 'fast' | 'regular' | 'smart' = args.requested === 'auto' ? 'fast' : args.requested;

    // Smart never gets downgraded.
    if (baseMode === 'smart') return done('smart', 'user_selected_smart', explicitSearch);

    // Hard upgrades.
    if (crisisDetected) return done('smart', 'crisis_keywords', false);
    if (sensitiveDetected) return done('smart', 'sensitive_topic', false);
    if (args.estimatedInputTokens >= MarvinRoutingService.SMART_TOKEN_THRESHOLD) {
      return done('smart', 'long_context', explicitSearch);
    }
    if (distinctAuthors >= 4) return done('smart', 'multi_user_thread', explicitSearch);
    if (signals.complexity === 'complex') return done('smart', 'complex_request', explicitSearch);

    // Soft upgrades Fast → Regular.
    if (baseMode === 'fast') {
      // Explicit search demand: upgrade so web search is available AND inject must-search instruction.
      if (explicitSearch) return done('regular', 'explicit_search_demand', true);
      // Implicit time-sensitive signal: upgrade so web search is available to the model.
      if (webSearchSignal) return done('regular', 'web_search_signal', false);
      // Non-trivial context length.
      if (args.estimatedInputTokens >= MarvinRoutingService.REGULAR_TOKEN_THRESHOLD) {
        return done('regular', 'medium_context', false);
      }
      if (signals.complexity === 'moderate') return done('regular', 'moderate_request', false);
    }

    // Explicit search demand at Regular/Smart: stay at requested mode, mark demanded.
    if (explicitSearch) return done(baseMode, 'explicit_search_demand', true);

    return done(baseMode, args.requested === 'auto' ? 'auto_routed' : 'user_selected', false);
  }

  /**
   * Crisis, long threads, and multi-author threads get `reasoning.effort=high`.
   * Sensitive-topic Smart stays at the Smart default (`medium`).
   */
  static shouldElevateReasoning(routed: { reason: string; crisisDetected: boolean }): boolean {
    if (routed.crisisDetected) return true;
    const reason = routed.reason.replace(/\+jev$/, '');
    return reason === 'crisis_keywords'
      || reason === 'long_context'
      || reason === 'multi_user_thread';
  }

  /** Cheap char→token approximation. ~4 chars/token works well enough for routing decisions. */
  estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }
}
