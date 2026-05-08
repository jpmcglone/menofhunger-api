import type { MarvinModeDto, MarvinSourceDto } from './marvin-mode.dto';

/**
 * Single Marv interaction event — successful AI reply, canned reply, or failure. Mirrors
 * the `MarvinUsageEvent` Prisma row but with friendly types (string ISO timestamps,
 * optional fields nullable rather than undefined) for the API contract.
 */
export type MarvinUsageEventDto = {
  id: string;
  userId: string;
  source: MarvinSourceDto;
  /** Post id (public) or conversation id (private). */
  sourceId: string;
  rootPostId: string | null;
  requestedMode: MarvinModeDto;
  effectiveMode: MarvinModeDto;
  creditsSpent: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  modelUsed: string | null;
  estimatedCostUsd: number | null;
  responseId: string | null;
  routingReason: string | null;
  errorCode: string | null;
  latencyMs: number | null;
  createdAt: string;
};
