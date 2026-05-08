import { Injectable } from '@nestjs/common';
import type { MarvinSource } from '@prisma/client';

/** Resolved mode — always one of the three real tiers, never 'auto'. */
export type ResolvedMarvinMode = 'fast' | 'regular' | 'smart';

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
  /** Threshold above which we pick at least Regular. */
  static readonly REGULAR_TOKEN_THRESHOLD = 2_000;
  /** Threshold above which we pick Smart. */
  static readonly SMART_TOKEN_THRESHOLD = 6_000;

  /**
   * Explicit web-search demand. These fire when the user is directly asking Marv to
   * look something up online. Upgrades Fast → Regular AND sets `webSearchDemanded=true`
   * so the prompt builder injects a "you MUST use web_search_preview" instruction.
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
    /\b(theolog\w*|reformed|calvinis\w+|arminian|sola\s+scriptura|trinity|atonement|eschatolog\w+)\b/i,
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
   */
  resolve(args: {
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
  }): { mode: ResolvedMarvinMode; reason: string; crisisDetected: boolean; webSearchDemanded: boolean } {
    const text = args.text ?? '';
    const distinctAuthors = Math.max(0, args.distinctAuthors ?? 0);

    const crisisDetected = MarvinRoutingService.CRISIS_PATTERNS.some((re) => re.test(text));
    const sensitiveDetected = MarvinRoutingService.SMART_TOPIC_PATTERNS.some((re) => re.test(text));
    const explicitSearch = args.webSearchEnabled
      ? MarvinRoutingService.EXPLICIT_SEARCH_PATTERNS.some((re) => re.test(text))
      : false;
    const webSearchSignal = args.webSearchEnabled && !explicitSearch
      ? MarvinRoutingService.WEB_SEARCH_PATTERNS.some((re) => re.test(text))
      : false;

    // 'auto' is treated as a routing hint to start from 'fast' and upgrade as needed —
    // same as if the user picked fast but with full upgrade eligibility.
    const baseMode: 'fast' | 'regular' | 'smart' = args.requested === 'auto' ? 'fast' : args.requested;

    // Smart never gets downgraded.
    if (baseMode === 'smart') {
      return { mode: 'smart', reason: 'user_selected_smart', crisisDetected, webSearchDemanded: explicitSearch };
    }

    // Hard upgrades.
    if (crisisDetected) return { mode: 'smart', reason: 'crisis_keywords', crisisDetected, webSearchDemanded: false };
    if (sensitiveDetected) return { mode: 'smart', reason: 'sensitive_topic', crisisDetected, webSearchDemanded: false };
    if (args.estimatedInputTokens >= MarvinRoutingService.SMART_TOKEN_THRESHOLD) {
      return { mode: 'smart', reason: 'long_context', crisisDetected, webSearchDemanded: explicitSearch };
    }
    if (distinctAuthors >= 4) {
      return { mode: 'smart', reason: 'multi_user_thread', crisisDetected, webSearchDemanded: explicitSearch };
    }

    // Soft upgrades Fast → Regular.
    if (baseMode === 'fast') {
      // Explicit search demand: upgrade so web search is available AND inject must-search instruction.
      if (explicitSearch) return { mode: 'regular', reason: 'explicit_search_demand', crisisDetected, webSearchDemanded: true };
      // Implicit time-sensitive signal: upgrade so web search is available to the model.
      if (webSearchSignal) return { mode: 'regular', reason: 'web_search_signal', crisisDetected, webSearchDemanded: false };
      // Non-trivial context length.
      if (args.estimatedInputTokens >= MarvinRoutingService.REGULAR_TOKEN_THRESHOLD) {
        return { mode: 'regular', reason: 'medium_context', crisisDetected, webSearchDemanded: false };
      }
    }

    // Explicit search demand at Regular/Smart: stay at requested mode, mark demanded.
    if (explicitSearch) {
      return { mode: baseMode, reason: 'explicit_search_demand', crisisDetected, webSearchDemanded: true };
    }

    return { mode: baseMode, reason: args.requested === 'auto' ? 'auto_routed' : 'user_selected', crisisDetected, webSearchDemanded: false };
  }

  /** Cheap char→token approximation. ~4 chars/token works well enough for routing decisions. */
  estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }
}
