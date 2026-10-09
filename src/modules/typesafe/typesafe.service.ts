import { Injectable, Logger } from '@nestjs/common';
import { TypeSafeClient, type Questions, type SystemOneRequest, type SystemOneResult } from '@typesafe-ai/sdk';
import { AppConfigService } from '../app/app-config.service';

export type TypeSafeDecideInput<Q extends Questions> = Pick<SystemOneRequest<Q>, 'state' | 'questions'> & {
  /** Short label for logs. Never put member content here. */
  purpose: string;
  /** Overrides the configured timeout for latency-sensitive callers. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type TypeSafeHealth = {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
  consecutiveFailures: number;
  inputTokensToday: number;
  spentTodayUsd: number;
  dailyBudgetUsd: number;
  budgetExhausted: boolean;
};

export type TypeSafeProbe =
  | { ok: true; latencyMs: number; models: string[] }
  | { ok: false; latencyMs: number; error: string; status: number | null };

/**
 * Typed-decision calls to TypeSafe AI (Jev).
 *
 * Jev returns choices, scores, or yes/no probabilities, not text. Callers own
 * thresholds and the fallback when this returns null (unconfigured, timeout, API error).
 * Context rule: a call may carry only what every member of that context can already read (a public
 * post, a group's own thread, one channel), never material from another group, channel, or DM.
 * Request content is never logged.
 */
@Injectable()
export class TypeSafeService {
  private readonly logger = new Logger(TypeSafeService.name);
  private client: TypeSafeClient | null = null;
  private health: TypeSafeHealth = {
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailure: null,
    consecutiveFailures: 0,
    inputTokensToday: 0,
    spentTodayUsd: 0,
    dailyBudgetUsd: 0,
    budgetExhausted: false,
  };
  private spend = { day: '', tokens: 0 };

  constructor(private readonly appConfig: AppConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.appConfig.typeSafe().apiKey);
  }

  /** In-process view of recent call outcomes, reported on the admin service-status page. */
  healthSnapshot(): TypeSafeHealth {
    const cfg = this.appConfig.typeSafe();
    return { ...this.health, inputTokensToday: this.spentToday(), spentTodayUsd: this.spentUsd(), dailyBudgetUsd: cfg.dailyBudgetUsd, budgetExhausted: this.overBudget() };
  }

  async decide<const Q extends Questions>(input: TypeSafeDecideInput<Q>): Promise<SystemOneResult<Q> | null> {
    const client = this.getClient();
    if (!client) return null;

    if (this.overBudget()) return null;

    const cfg = this.appConfig.typeSafe();
    const startedAt = Date.now();
    try {
      const result = await client.systemOne(
        { state: input.state, questions: input.questions, model: cfg.model },
        { signal: input.signal, ...(input.timeoutMs ? { timeout: input.timeoutMs } : {}) },
      );
      this.recordSuccess();
      this.spend.tokens = this.spentToday() + result.usage.input_tokens;
      this.logger.log(
        `[typesafe] ${input.purpose} model=${result.model} in ${Date.now() - startedAt}ms ` +
          `tokens=${result.usage.input_tokens}/${result.usage.output_tokens}`,
      );
      return result;
    } catch (err) {
      const message = errorMessage(err);
      this.recordFailure(message);
      this.logger.warn(`[typesafe] ${input.purpose} failed in ${Date.now() - startedAt}ms: ${message}`);
      return null;
    }
  }

  /** Lists available models. Cheap, content-free, and proves the key and network path work. */
  async probe(timeoutMs = 4000): Promise<TypeSafeProbe | null> {
    const client = this.getClient();
    if (!client) return null;
    const startedAt = Date.now();
    try {
      const cards = await client.models.list({ timeout: timeoutMs, retry: { maxRetries: 0 } });
      this.recordSuccess();
      return { ok: true, latencyMs: Date.now() - startedAt, models: cards.map((card) => card.name) };
    } catch (err) {
      const message = errorMessage(err);
      this.recordFailure(message);
      const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null;
      return { ok: false, latencyMs: Date.now() - startedAt, error: message, status };
    }
  }

  private spentToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    if (this.spend.day !== day) this.spend = { day, tokens: 0 };
    return this.spend.tokens;
  }

  private spentUsd(): number {
    return (this.spentToday() / 1_000_000) * this.appConfig.typeSafe().inputUsdPerMillionTokens;
  }

  private overBudget(): boolean {
    const budget = this.appConfig.typeSafe().dailyBudgetUsd;
    if (!budget || this.spentUsd() < budget) return false;
    if (!this.budgetWarned || this.budgetWarned !== this.spend.day) {
      this.budgetWarned = this.spend.day;
      this.logger.warn(`[typesafe] daily budget of $${budget} reached; Jev calls are paused until tomorrow (UTC) and callers use their fallbacks.`);
    }
    return true;
  }

  private budgetWarned = '';

  private recordSuccess(): void {
    this.health = { ...this.health, lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0 };
  }

  private recordFailure(message: string): void {
    this.health = {
      ...this.health,
      lastFailureAt: new Date().toISOString(),
      lastFailure: message.slice(0, 300),
      consecutiveFailures: this.health.consecutiveFailures + 1,
    };
  }

  private getClient(): TypeSafeClient | null {
    const cfg = this.appConfig.typeSafe();
    if (!cfg.apiKey) return null;
    if (this.client) return this.client;
    this.client = new TypeSafeClient({
      apiKey: cfg.apiKey,
      defaultModel: cfg.model,
      timeout: cfg.timeoutMs,
    });
    return this.client;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
