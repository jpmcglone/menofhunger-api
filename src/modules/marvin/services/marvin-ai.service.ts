import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import type { MarvinSource } from '@prisma/client';
import { AppConfigService } from '../../app/app-config.service';
import type { ResolvedMarvinMode } from './marvin-routing.service';
import {
  MARV_DEFAULT_FAST_MODEL,
  MARV_DEFAULT_REGULAR_MODEL,
  MARV_DEFAULT_SMART_MODEL,
} from '../marvin-models';

export type MarvAIToolCallContext = {
  /** Source-scoped ids the tool handlers may use. */
  rootPostId?: string;
  triggeringPostId?: string;
  conversationId?: string;
  /** The requesting user — used by tools that need to scope queries to "the requester". */
  requesterUserId: string;
  /** @handle of the requesting user — attached to OpenAI response metadata for per-user spend visibility. */
  requesterUsername?: string | null;
};

export type MarvAIToolDispatcher = (
  name: string,
  args: unknown,
  ctx: MarvAIToolCallContext,
) => Promise<string>;

export type MarvAIRequest = {
  source: MarvinSource;
  mode: ResolvedMarvinMode;
  /** Per-request developer note (who's asking, where, safety nudges). */
  developerNote: string;
  /** The user's actual question text. */
  userMessage: string;
  /**
   * Public URLs of images/GIFs to attach as vision inputs on the first turn.
   * Only attached when `MARV_VISION_ENABLED=true` and the mode is in `MARV_VISION_MODES`.
   * Already capped to `MARV_VISION_MAX_IMAGES_PER_TURN` by the processor.
   */
  imageUrls?: string[];
  /** Tool dispatcher that handles function calls from the model. */
  dispatchTool: MarvAIToolDispatcher;
  /** Per-request context passed to every tool dispatch. */
  toolContext: MarvAIToolCallContext;
  /** Used by private DM sessions to chain conversation memory. */
  previousResponseId?: string | null;
  /** Stable id used as OpenAI's prompt_cache_key (lower latency for repeat shapes). */
  cacheKey?: string;
};

export type MarvAIResult = {
  text: string;
  modelUsed: string;
  responseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  estimatedCostUsd: number | null;
  toolCallCount: number;
  /** Number of `web_search_call` items OpenAI executed during this response. */
  webSearchCount: number;
  /** Number of `fetch_url_content` tool calls dispatched during this response. */
  urlFetchCount: number;
  /** Number of images actually attached as vision inputs on turn one. */
  imagesAttached: number;
  /** Set when the model returned no usable text (refusal, max-output stop, etc.). */
  errorCode?: 'no_text' | 'refusal' | 'incomplete';
};

/** Per-1M-token rate (USD) for cost estimation. Approximate; admins can tweak per-deploy. */
const MODEL_RATES_USD_PER_M_TOKENS: Record<string, { input: number; output: number; cached?: number }> = {
  [MARV_DEFAULT_FAST_MODEL]: { input: 0.05, output: 0.4, cached: 0.005 },
  [MARV_DEFAULT_REGULAR_MODEL]: { input: 1.25, output: 10, cached: 0.125 },
  [MARV_DEFAULT_SMART_MODEL]: { input: 5, output: 30, cached: 0.5 },
};

/** Flat cost per web_search_preview call (OpenAI pricing, USD). */
const WEB_SEARCH_COST_USD = 0.03;

/** Tool-loop budget. Two @username lookups easily burn 4 rounds (card + basic × 2). */
const MAX_TOOL_ROUNDS = 8;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_RETRY_MS = 400;

function openaiErrorStatus(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err) {
    const n = Number((err as { status?: unknown }).status);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function openaiErrorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRateLimitError(err: unknown): boolean {
  const status = openaiErrorStatus(err);
  const text = openaiErrorText(err).toLowerCase();
  return status === 429 || text.includes('rate limit') || text.includes('429');
}

function isStalePreviousResponseError(err: unknown): boolean {
  const status = openaiErrorStatus(err);
  const text = openaiErrorText(err).toLowerCase();
  if (status != null && status !== 400 && status !== 404) return false;
  return (
    text.includes('previous_response') ||
    text.includes('previous response') ||
    text.includes('no tool output found for function call')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OpenAI Responses API wrapper for Marv.
 *
 * Architecture:
 *  - Personality (system prompt + tool list) lives in an OpenAI **Stored Prompt**
 *    referenced by `OPENAI_MARV_PROMPT_ID`. We don't duplicate it in code.
 *  - Per-request, we override `model` (Fast/Regular/Smart) so the same personality
 *    runs at three quality/cost tiers.
 *  - When the model emits `function_call` items, we dispatch to local tool handlers
 *    and feed their outputs back via `previous_response_id` + `function_call_output`
 *    input items. We loop up to MAX_TOOL_ROUNDS, dispatching any pending calls even
 *    on the last round, then force a text turn (`tool_choice: none`) if needed.
 *  - Output is hard-capped via `max_output_tokens` to protect cost/latency budgets.
 */
@Injectable()
export class MarvinAIService {
  private readonly logger = new Logger(MarvinAIService.name);
  private clientPromise: Promise<OpenAI | null> | null = null;

  constructor(private readonly appConfig: AppConfigService) {}

  /**
   * Returns true when OpenAI is configured (api key + stored prompt id).
   * Callers can short-circuit before scheduling a job when this is false.
   */
  isConfigured(): boolean {
    const cfg = this.appConfig.marvOpenAI();
    return Boolean(cfg.apiKey && cfg.promptId);
  }

  modelForMode(mode: ResolvedMarvinMode): string {
    const cfg = this.appConfig.marvOpenAI();
    switch (mode) {
      case 'fast':
        return cfg.fastModel;
      case 'regular':
        return cfg.regularModel;
      case 'smart':
        return cfg.smartModel;
      default:
        return cfg.regularModel;
    }
  }

  /**
   * Send a request to the OpenAI Responses API and resolve to Marv's reply text + usage.
   *
   * Throws when OpenAI is not configured (callers should `isConfigured()` first); the
   * processor catches and writes a `MarvinUsageEvent` with `errorCode='ai_error'` instead
   * of posting a reply.
   */
  async respond(req: MarvAIRequest): Promise<MarvAIResult> {
    const cfg = this.appConfig.marvOpenAI();
    const limits = this.appConfig.marvLimits();
    const promptId = cfg.promptId;
    if (!cfg.apiKey || !promptId) {
      this.logger.warn(
        `[marv-ai] respond() refused: not configured apiKey=${!!cfg.apiKey} promptId=${!!promptId}`,
      );
      throw new MarvinAINotConfiguredError();
    }

    const client = await this.getClient();
    if (!client) {
      this.logger.warn('[marv-ai] respond() refused: OpenAI client could not be initialized.');
      throw new MarvinAINotConfiguredError();
    }

    const model = this.modelForMode(req.mode);
    this.logger.log(
      `[marv-ai] respond start source=${req.source} mode=${req.mode} model=${model} promptId=${promptId} maxOut=${limits.maxOutputTokens} prevResp=${req.previousResponseId ?? 'null'} cacheKey=${req.cacheKey ?? '-'}`,
    );

    // Vision: only activate when feature flag is on and mode is in allowed list.
    const visionActive =
      cfg.visionEnabled && cfg.visionModes.includes(req.mode as string);
    const imageUrls = visionActive && req.imageUrls && req.imageUrls.length > 0
      ? req.imageUrls.slice(0, cfg.visionMaxImagesPerTurn)
      : [];

    if (visionActive && imageUrls.length > 0) {
      this.logger.log(
        `[marv-ai] vision enabled for mode=${req.mode} images=${imageUrls.length}`,
      );
    }

    // Build the initial input. The personality + tool list live in the Stored Prompt; the
    // developer note + user question travel as the "input" for this turn.
    // When images are attached, the user role uses a content-parts array; otherwise a plain string.
    // ResponseInputImage requires `detail` (non-optional in the SDK type). Omitting it causes
    // the API to silently ignore the image content — the model responds as if no image was sent.
    const userContent: unknown = imageUrls.length > 0
      ? [
          { type: 'input_text', text: req.userMessage },
          ...imageUrls.map((u) => ({ type: 'input_image', image_url: u, detail: 'auto' })),
        ]
      : req.userMessage;

    const initialInput = [
      {
        role: 'developer' as const,
        content: req.developerNote,
      },
      {
        role: 'user' as const,
        content: userContent,
      },
    ];

    let responseId: string | null = null;
    let aggregatedInputTokens = 0;
    let aggregatedOutputTokens = 0;
    let aggregatedCachedTokens = 0;
    let toolCallCount = 0;
    let webSearchCount = 0;
    let urlFetchCount = 0;
    let lastTextFromAssistant = '';
    let errorCode: MarvAIResult['errorCode'] | undefined;

    // `store: true` is required for multi-round tool calling: OpenAI assigns server-side
    // item IDs (rs_...) to output items and those IDs must be resolvable on subsequent
    // turns. With `store: false` the IDs are orphaned and the API returns a 404. We store
    // all Marv responses; private sessions additionally use `previous_response_id` for
    // conversation memory across messages.

    // Web search is only enabled when: the feature flag is on AND the current mode is in the
    // allowed list. fast (gpt-5.4-nano) is excluded by default — it exhausts its token budget
    // on search result processing and never gets to produce visible text.
    const webSearchActive =
      cfg.webSearchEnabled && cfg.webSearchModes.includes(req.mode as string);

    // When web search is active, use a higher output-token budget so the model has room to
    // both process results and write a reply. Falls back to the base limit if larger.
    const effectiveMaxOutputTokens = webSearchActive
      ? Math.max(limits.maxOutputTokens, cfg.webSearchMaxOutputTokens)
      : limits.maxOutputTokens;

    const baseRequest: Record<string, unknown> = {
      model,
      prompt: { id: promptId },
      max_output_tokens: effectiveMaxOutputTokens,
      store: true,
      prompt_cache_key: req.cacheKey,
      // Tag every request with the MOH user id so OpenAI's Usage dashboard
      // breaks down spend per end-user (Users tab) instead of lumping all
      // traffic under the API key owner.
      user: req.toolContext.requesterUserId,
      // Richer context stored on the response object — queryable via API and
      // visible in Stored Responses. Helps correlate cost spikes to feature
      // areas and specific users without parsing logs.
      metadata: {
        moh_user_id: req.toolContext.requesterUserId,
        ...(req.toolContext.requesterUsername
          ? { moh_username: req.toolContext.requesterUsername }
          : {}),
        moh_source: req.source,
        moh_mode: req.mode,
      },
    };

    // Local tools always registered in-code so they work even if the Stored Prompt
    // tool list drifts. Keep the OpenAI Stored Prompt in sync for documentation.
    const tools: unknown[] = [
      {
        type: 'function',
        name: 'fetch_url_content',
        description:
          'Fetch and read the full text content of a web page. Use this when the user or conversation contains a URL and you need to understand what the page says before responding. Only fetch URLs that are directly relevant to your reply.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The full URL to fetch, starting with http:// or https://.',
            },
          },
          required: ['url'],
        },
      },
      {
        type: 'function',
        name: 'get_bible_passage',
        description:
          'Look up the exact text of a Bible passage by reference (non-AI lookup). Use ONLY when the user asks for Scripture or a specific verse/passage. Do not volunteer Scripture unprompted.',
        parameters: {
          type: 'object',
          properties: {
            reference: {
              type: 'string',
              description:
                'A scripture reference such as "John 3:16", "Romans 8:28-30", "Rom 9", or "Eph 2:1,8".',
            },
          },
          required: ['reference'],
        },
      },
      {
        type: 'function',
        name: 'find_similar_members',
        description:
          'Find platform members similar to the requester or matching a short interest/query (interests + public profile cards). Use when the user asks who they should meet or if anyone else is into a topic.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Optional short topic or interest (e.g. "woodworking", "Texas", "fasting"). Omit to match the requester\'s own interests/profile.',
            },
            limit: {
              type: 'integer',
              description: 'Max members to return (1–8). Default 5.',
            },
          },
          required: [],
        },
      },
    ];
    if (webSearchActive) {
      tools.push({ type: 'web_search_preview' });
      this.logger.log(
        `[marv-ai] web_search_preview enabled for mode=${req.mode} maxOutputTokens=${effectiveMaxOutputTokens}`,
      );
    }
    baseRequest.tools = tools;

    // First turn: send the developer note + user question. If the caller provided
    // `previousResponseId` (private session continuation), reference it.
    let nextRequest: Record<string, unknown> = {
      ...baseRequest,
      input: initialInput,
    };
    if (req.previousResponseId) nextRequest.previous_response_id = req.previousResponseId;
    let isToolFollowUp = false;
    let pendingAtExit = false;

    const absorbUsage = (usage: any) => {
      if (!usage) return;
      aggregatedInputTokens += Number(usage.input_tokens ?? 0);
      aggregatedOutputTokens += Number(usage.output_tokens ?? 0);
      aggregatedCachedTokens +=
        Number(usage.input_tokens_details?.cached_tokens ?? 0) + Number(usage.cached_tokens ?? 0);
    };

    const dispatchPending = async (
      round: number,
      pendingToolCalls: Array<{ call_id: string; name: string; arguments: string }>,
    ): Promise<Array<{ type: 'function_call_output'; call_id: string; output: string }>> => {
      return await Promise.all(
        pendingToolCalls.map(async (call) => {
          toolCallCount++;
          if (call.name === 'fetch_url_content') urlFetchCount++;
          const argsStr = call.arguments ?? '{}';
          let args: unknown = {};
          try {
            args = JSON.parse(argsStr);
          } catch {
            args = {};
          }
          const toolStartedAt = Date.now();
          let output: string;
          try {
            this.logger.log(
              `[marv-ai] round=${round} tool="${call.name}" call=${call.call_id} args=${argsStr.slice(0, 200)}`,
            );
            output = await req.dispatchTool(call.name, args, req.toolContext);
            this.logger.log(
              `[marv-ai] round=${round} tool="${call.name}" call=${call.call_id} OK in ${Date.now() - toolStartedAt}ms outputLen=${output.length}`,
            );
          } catch (err) {
            this.logger.warn(
              `[marv-ai] tool="${call.name}" threw in ${Date.now() - toolStartedAt}ms: ${openaiErrorText(err)}`,
            );
            output = JSON.stringify({ error: 'tool_failed' });
          }
          return {
            type: 'function_call_output' as const,
            call_id: call.call_id,
            output: output.slice(0, 8_000),
          };
        }),
      );
    };

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const roundStartedAt = Date.now();
      this.logger.log(`[marv-ai] round=${round} → POST /v1/responses model=${model}`);
      let result: any;
      try {
        result = await this.createResponse(client, nextRequest, {
          allowDropPreviousResponse: !isToolFollowUp,
        });
      } catch (err) {
        this.logger.error(
          `[marv-ai] round=${round} OpenAI request FAILED in ${Date.now() - roundStartedAt}ms: ${openaiErrorText(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        throw err;
      }
      responseId = result?.id ?? responseId;
      absorbUsage(result?.usage);

      const textFromThisTurn = MarvinAIService.extractText(result);
      if (textFromThisTurn) lastTextFromAssistant = textFromThisTurn;

      const pendingToolCalls = MarvinAIService.extractFunctionCalls(result);
      const roundWebSearches = MarvinAIService.extractWebSearchCount(result);
      webSearchCount += roundWebSearches;
      this.logger.log(
        `[marv-ai] round=${round} ← OK in ${Date.now() - roundStartedAt}ms status=${result?.status ?? '?'} resp=${responseId} textLen=${textFromThisTurn.length} toolCalls=${pendingToolCalls.length} webSearches=${roundWebSearches} usage=in${result?.usage?.input_tokens ?? 0}/out${result?.usage?.output_tokens ?? 0}`,
      );

      if (pendingToolCalls.length === 0) {
        pendingAtExit = false;
        if (!lastTextFromAssistant) {
          const status = String(result?.status ?? '');
          if (status === 'incomplete') errorCode = 'incomplete';
          else errorCode = 'no_text';
          this.logger.warn(
            `[marv-ai] round=${round} FINAL with NO text status=${status} errorCode=${errorCode} resp=${responseId} — likely max_output_tokens exhausted, refusal, or empty completion.`,
          );
        }
        break;
      }

      const toolOutputs = await dispatchPending(round, pendingToolCalls);
      isToolFollowUp = true;

      if (round === MAX_TOOL_ROUNDS) {
        this.logger.warn(
          `[marv-ai] Hit MAX_TOOL_ROUNDS=${MAX_TOOL_ROUNDS} — forcing a final text turn (model=${model}, response=${responseId}).`,
        );
        try {
          const forceStartedAt = Date.now();
          const forceResult: any = await this.createResponse(
            client,
            {
              ...baseRequest,
              previous_response_id: responseId,
              input: toolOutputs,
              tool_choice: 'none',
            },
            { allowDropPreviousResponse: false },
          );
          absorbUsage(forceResult?.usage);
          const forceText = MarvinAIService.extractText(forceResult);
          this.logger.log(
            `[marv-ai] force-final ← in ${Date.now() - forceStartedAt}ms status=${forceResult?.status ?? '?'} textLen=${forceText.length}`,
          );
          if (forceText) {
            lastTextFromAssistant = forceText;
            responseId = forceResult?.id ?? responseId;
            errorCode = undefined;
            pendingAtExit = false;
          } else {
            errorCode = 'incomplete';
            pendingAtExit = MarvinAIService.extractFunctionCalls(forceResult).length > 0;
          }
        } catch (err) {
          this.logger.warn(`[marv-ai] force-final request failed: ${openaiErrorText(err)}`);
          errorCode = 'incomplete';
          pendingAtExit = true;
        }
        break;
      }

      nextRequest = {
        ...baseRequest,
        previous_response_id: responseId,
        input: toolOutputs,
      };
    }

    // ── Incomplete-response recovery ────────────────────────────────────────
    // Reasoning models spend tokens on internal thinking before emitting visible
    // text. If we hit the budget mid-think, status=incomplete with no text.
    // Continuing from a response that still has unfulfilled function calls 400s
    // ("No tool output found for function call"), so that path only runs when
    // the chain is clean. Otherwise we start a fresh "answer now" turn.
    if ((errorCode === 'incomplete' || errorCode === 'no_text') && !lastTextFromAssistant) {
      const retryTokens = Math.min(limits.maxOutputTokens * 8, 16_384);

      if (responseId && !pendingAtExit) {
        this.logger.warn(
          `[marv-ai] incomplete with no text — retrying once with ${retryTokens} tokens (chaining resp=${responseId})`,
        );
        try {
          const retryStartedAt = Date.now();
          const retryResult: any = await this.createResponse(
            client,
            {
              ...baseRequest,
              max_output_tokens: retryTokens,
              previous_response_id: responseId,
              input: [],
              tool_choice: 'none',
            },
            { allowDropPreviousResponse: true },
          );
          absorbUsage(retryResult?.usage);
          const retryText = MarvinAIService.extractText(retryResult);
          this.logger.log(
            `[marv-ai] retry ← in ${Date.now() - retryStartedAt}ms status=${retryResult?.status ?? '?'} textLen=${retryText.length}`,
          );
          if (retryText) {
            lastTextFromAssistant = retryText;
            responseId = retryResult?.id ?? responseId;
            errorCode = undefined;
            this.logger.log('[marv-ai] retry succeeded — text recovered.');
          }
        } catch (err) {
          this.logger.warn(`[marv-ai] retry request failed: ${openaiErrorText(err)}`);
        }
      }

      if (!lastTextFromAssistant) {
        this.logger.warn(
          `[marv-ai] starting a fresh answer-now turn (${retryTokens} tokens, no previous_response_id)`,
        );
        try {
          const freshStartedAt = Date.now();
          const freshResult: any = await this.createResponse(
            client,
            {
              ...baseRequest,
              max_output_tokens: retryTokens,
              tool_choice: 'none',
              input: [
                ...initialInput,
                {
                  role: 'developer' as const,
                  content:
                    'Your previous attempt did not finish. Answer the user now with what you already know. Do not call tools.',
                },
              ],
            },
            { allowDropPreviousResponse: false },
          );
          absorbUsage(freshResult?.usage);
          const freshText = MarvinAIService.extractText(freshResult);
          this.logger.log(
            `[marv-ai] fresh ← in ${Date.now() - freshStartedAt}ms status=${freshResult?.status ?? '?'} textLen=${freshText.length}`,
          );
          if (freshText) {
            lastTextFromAssistant = freshText;
            responseId = freshResult?.id ?? responseId;
            errorCode = undefined;
          } else {
            this.logger.warn(
              `[marv-ai] fresh turn also returned no text (status=${freshResult?.status ?? '?'}); caller will surface canned fallback.`,
            );
          }
        } catch (err) {
          this.logger.warn(`[marv-ai] fresh turn failed: ${openaiErrorText(err)}`);
        }
      }
    }

    const modelRate = MODEL_RATES_USD_PER_M_TOKENS[model] ?? null;
    let estimatedCostUsd: number | null = null;
    if (modelRate) {
      const cachedRate = modelRate.cached ?? modelRate.input;
      const billedInput = Math.max(0, aggregatedInputTokens - aggregatedCachedTokens);
      const tokenCost =
        (billedInput * modelRate.input + aggregatedCachedTokens * cachedRate + aggregatedOutputTokens * modelRate.output) /
        1_000_000;
      const searchCost = webSearchCount * WEB_SEARCH_COST_USD;
      const total = tokenCost + searchCost;
      estimatedCostUsd = Number.isFinite(total) ? Number(total.toFixed(6)) : null;
    }

    return {
      text: MarvinAIService.cleanReplyText(lastTextFromAssistant),
      modelUsed: model,
      responseId,
      inputTokens: aggregatedInputTokens || null,
      outputTokens: aggregatedOutputTokens || null,
      cachedInputTokens: aggregatedCachedTokens || null,
      estimatedCostUsd,
      toolCallCount,
      webSearchCount,
      urlFetchCount,
      imagesAttached: imageUrls.length,
      ...(errorCode ? { errorCode } : {}),
    };
  }

  private async getClient(): Promise<OpenAI | null> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      const cfg = this.appConfig.marvOpenAI();
      if (!cfg.apiKey) return null;
      return new OpenAI({ apiKey: cfg.apiKey });
    })();
    return this.clientPromise;
  }

  /**
   * POST /v1/responses with retries for 429s and a one-shot drop of a stale
   * `previous_response_id` (expired chain or unfulfilled function calls).
   * Tool-follow-up turns must NOT drop the id — the function_call_output items
   * are meaningless without it.
   */
  private async createResponse(
    client: OpenAI,
    request: Record<string, unknown>,
    opts: { allowDropPreviousResponse: boolean },
  ): Promise<any> {
    const current: Record<string, unknown> = { ...request };
    const maxAttempts = 1 + RATE_LIMIT_RETRIES;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await client.responses.create({ ...current } as any);
      } catch (err) {
        if (
          opts.allowDropPreviousResponse &&
          current.previous_response_id &&
          isStalePreviousResponseError(err)
        ) {
          this.logger.warn(
            `[marv-ai] dropping stale previous_response_id=${String(current.previous_response_id)}: ${openaiErrorText(err)}`,
          );
          delete current.previous_response_id;
          continue;
        }
        if (isRateLimitError(err) && attempt < maxAttempts - 1) {
          const waitMs = RATE_LIMIT_RETRY_MS * 2 ** attempt;
          this.logger.warn(
            `[marv-ai] rate-limited — retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`,
          );
          await sleep(waitMs);
          continue;
        }
        throw err;
      }
    }
    throw new Error('OpenAI request failed after retries');
  }

  /** Pull the assistant's plain-text content out of a Responses API result. */
  static extractText(result: any): string {
    const output = Array.isArray(result?.output) ? result.output : [];
    let text = '';
    for (const item of output) {
      if (!item) continue;
      if (item.type === 'message') {
        const parts = Array.isArray(item.content) ? item.content : [];
        for (const part of parts) {
          if (part?.type === 'output_text' && typeof part.text === 'string') {
            text += part.text;
          }
        }
      }
    }
    if (!text && typeof result?.output_text === 'string') text = result.output_text;
    return text.trim();
  }

  /** Count completed web_search_call items in a Responses API result. */
  static extractWebSearchCount(result: any): number {
    const output = Array.isArray(result?.output) ? result.output : [];
    return output.filter((item: any) => item?.type === 'web_search_call').length;
  }

  /** Find any unanswered function tool calls in a Responses API result. */
  static extractFunctionCalls(result: any): Array<{ call_id: string; name: string; arguments: string }> {
    const output = Array.isArray(result?.output) ? result.output : [];
    const calls: Array<{ call_id: string; name: string; arguments: string }> = [];
    for (const item of output) {
      if (!item) continue;
      const callId = item.call_id ?? item.id;
      if (item.type === 'function_call' && callId && item.name) {
        calls.push({
          call_id: String(callId),
          name: String(item.name),
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        });
      }
    }
    return calls;
  }

  /** Strip stray "Marv:" prefix the model occasionally produces. */
  static cleanReplyText(text: string): string {
    if (!text) return '';
    const trimmed = text.trim();
    return trimmed.replace(/^marv\s*:\s*/i, '');
  }
}

export class MarvinAINotConfiguredError extends Error {
  constructor() {
    super('OpenAI / Marv is not configured (need OPENAI_API_KEY and OPENAI_MARV_PROMPT_ID).');
    this.name = 'MarvinAINotConfiguredError';
  }
}
