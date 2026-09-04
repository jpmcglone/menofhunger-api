import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { AppConfigService } from '../app/app-config.service';

export type AiUtilityCompleteInput = {
  model: string;
  instructions: string;
  userMessage: string;
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  cacheKey?: string;
};

export type AiUtilityCompleteResult = {
  text: string;
  modelUsed: string;
};

/**
 * OpenAI Responses calls that are not Marv-the-character.
 *
 * Topic labeling and admin briefs must not inherit the stored Marv prompt
 * (80-word DM voice). This path sends `instructions` only and needs an API key,
 * not `OPENAI_MARV_PROMPT_ID`.
 */
@Injectable()
export class AiUtilityService {
  private readonly logger = new Logger(AiUtilityService.name);
  private clientPromise: Promise<OpenAI | null> | null = null;

  constructor(private readonly appConfig: AppConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.appConfig.marvOpenAI().apiKey);
  }

  async complete(input: AiUtilityCompleteInput): Promise<AiUtilityCompleteResult | null> {
    const cfg = this.appConfig.marvOpenAI();
    if (!cfg.apiKey) return null;

    const client = await this.getClient();
    if (!client) return null;

    const maxOutputTokens = Math.max(64, Math.min(8_192, Math.floor(input.maxOutputTokens ?? 512)));
    const reasoningEffort = input.reasoningEffort ?? 'low';
    const startedAt = Date.now();

    try {
      const result = await client.responses.create({
        model: input.model,
        instructions: input.instructions,
        input: input.userMessage,
        max_output_tokens: maxOutputTokens,
        reasoning: { effort: reasoningEffort },
        text: { verbosity: 'low' },
        store: false,
        ...(input.cacheKey ? { prompt_cache_key: input.cacheKey } : {}),
      } as any);
      const text = extractOutputText(result);
      this.logger.log(
        `[ai-utility] complete model=${input.model} effort=${reasoningEffort} in ${Date.now() - startedAt}ms textLen=${text.length}`,
      );
      return { text, modelUsed: input.model };
    } catch (err) {
      this.logger.warn(
        `[ai-utility] complete failed model=${input.model}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async getClient(): Promise<OpenAI | null> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      const apiKey = this.appConfig.marvOpenAI().apiKey;
      if (!apiKey) return null;
      return new OpenAI({ apiKey });
    })();
    return this.clientPromise;
  }
}

function extractOutputText(result: any): string {
  const output = Array.isArray(result?.output) ? result.output : [];
  let text = '';
  for (const item of output) {
    if (!item || item.type !== 'message') continue;
    const parts = Array.isArray(item.content) ? item.content : [];
    for (const part of parts) {
      if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
    }
  }
  if (!text && typeof result?.output_text === 'string') text = result.output_text;
  return text.trim();
}
