import type { MarvinCreditSummaryDto } from './marvin-credit-summary.dto';
import type { MarvinModeDto } from './marvin-mode.dto';

/**
 * Per-mode credit costs — allows the UI to show "Fast: 1 credit / Regular: 2 credits" etc.
 * Values come from config so they stay accurate when an operator changes the knobs.
 */
export type MarvinCostsDto = {
  fast: number;
  regular: number;
  smart: number;
  /** Extra credits charged per web-search call the model makes. */
  webSearchSurcharge: number;
  /** Extra credits charged per image passed to a vision-capable model. */
  visionPerImage: number;
  /** Extra credits charged per URL the model fetches via the url-fetch tool. */
  urlFetchSurcharge: number;
};

/**
 * Combined "everything the chat page / settings need" envelope for the requesting user.
 * Backed by `GET /marvin/me`.
 */
export type MarvinMeDto = {
  /** Whether Marv is enabled for this app + this user (admin can disable per user). */
  enabled: boolean;
  /** True when the user is on a tier that grants AI replies (premium / premium plus). */
  isPremium: boolean;
  /** Mode this user picked in settings. The composer + processor honor this by default. */
  preferredMode: MarvinModeDto;
  /** Latest credit-bucket snapshot. */
  credits: MarvinCreditSummaryDto;
  /** Per-mode base costs + surcharges. Used by the UI to preview spend before hitting "Catch me up". */
  costs: MarvinCostsDto;
  /** Marv bot user reference for the chat-page pinned row. */
  marv: {
    userId: string;
    username: string;
    displayName: string;
    /**
     * Resolved public avatar URL for Marv, or `null` when no avatar is set
     * (the pinned row falls back to a styled icon in that case).
     */
    avatarUrl: string | null;
  } | null;
};

/**
 * Body for `PATCH /marvin/me/preferences`. Single field for now; add more as we go.
 */
export type MarvinUpdatePreferencesBodyDto = {
  preferredMode?: MarvinModeDto;
};
