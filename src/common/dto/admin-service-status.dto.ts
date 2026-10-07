/** Traffic-light severity shown on the admin Service status page. */
export type AdminServiceLevel = "green" | "yellow" | "red";

/**
 * - connected: a live check succeeded.
 * - configured: required settings are present; no live check exists for this service.
 * - not_configured: no settings found.
 * - partial: some required settings are present and some are missing.
 * - failing: settings are present but the live check or recent calls fail.
 * - disabled: deliberately switched off by a feature flag.
 */
export type AdminServiceState =
  | "connected"
  | "configured"
  | "not_configured"
  | "partial"
  | "failing"
  | "disabled";

export type AdminServiceFeatureDto = {
  label: string;
  enabled: boolean;
};

export type AdminServiceStatusItemDto = {
  id: string;
  name: string;
  group: string;
  level: AdminServiceLevel;
  state: AdminServiceState;
  /** One line a person can read at a glance. */
  summary: string;
  /** Extra context such as an error message. Never contains secret values. */
  detail: string | null;
  /** Environment variable names (never values) that are missing. */
  missingKeys: string[];
  /** What members or admins lose, or what falls back, when this is unavailable. */
  impact: string;
  /** True when this status came from a live request rather than from settings alone. */
  checkedLive: boolean;
  latencyMs: number | null;
  features: AdminServiceFeatureDto[];
};

export type AdminServiceStatusDto = {
  asOf: string;
  environment: string;
  overall: AdminServiceLevel;
  counts: { green: number; yellow: number; red: number };
  services: AdminServiceStatusItemDto[];
};
