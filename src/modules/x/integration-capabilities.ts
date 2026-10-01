import type { IntegrationCapabilityDto } from "../../common/dto/integrations.dto";
import { X_REFERENCE_PRICES } from "./integration-budget.policy";

type XCapabilityContext = {
  connected: boolean;
  scopes: string;
  premiumPlus: boolean;
  sharedBudget: boolean;
  confirmedPrices: boolean;
  imageUploadPriceKnown: boolean;
  advanced?: {
    enabled: boolean;
    account: boolean;
    quote: boolean;
    longText: boolean;
    edit: boolean;
    postMaxMicros?: number;
    mediaMaxMicros?: number;
    priceVersion: string;
  };
  article?: {
    enabled: boolean;
    cost: number;
    priceVersion: string;
    bucket: string;
  };
};

/** Explicit state is a contract: an undocumented route is never a supported format. */
export function xCapabilities(
  context: XCapabilityContext,
): IntegrationCapabilityDto[] {
  const scopes = new Set(context.scopes.split(/\s+/));
  const publishScopes = ["tweet.read", "tweet.write", "users.read"];
  const permission =
    context.connected && publishScopes.every((scope) => scopes.has(scope));
  const base = (
    action: string,
    state: IntegrationCapabilityDto["state"],
    cost: number | null,
    requiredScopes = publishScopes,
    reason: string | null = null,
  ): IntegrationCapabilityDto => ({
    provider: "x",
    action,
    state,
    unitCostMicros: cost,
    requiredScopes,
    billingUnit: cost === null ? "unknown" : "request",
    priceVersion:
      context.confirmedPrices && cost !== null
        ? X_REFERENCE_PRICES.version
        : null,
    reason,
  });
  const createState = !permission
    ? "awaiting_permission"
    : context.sharedBudget && !context.confirmedPrices
      ? "temporarily_unavailable"
      : "supported";
  return [
    base("text", createState, X_REFERENCE_PRICES.create),
    base(
      "url",
      !permission
        ? "awaiting_permission"
        : context.sharedBudget && context.confirmedPrices && context.premiumPlus
          ? "supported"
          : "temporarily_unavailable",
      X_REFERENCE_PRICES.createWithUrl,
      publishScopes,
      "Premium+ and a confirmed shared high-cost allowance are required.",
    ),
    base(
      "photos",
      !permission || !scopes.has("media.write")
        ? "awaiting_permission"
        : context.sharedBudget &&
            (!context.confirmedPrices || !context.imageUploadPriceKnown)
          ? "temporarily_unavailable"
          : "supported",
      null,
      [...publishScopes, "media.write"],
      "Up to four photos. Upload and alt-text costs must be confirmed before paid rollout.",
    ),
    ...[
      "video",
      "gif",
      "poll",
      "longText",
      "thread",
      "reply",
      "quote",
      "edit",
    ].map((action) => {
      const advanced = context.advanced;
      const media = action === "video" || action === "gif";
      const access =
        advanced?.account &&
        (action !== "quote" || advanced.quote) &&
        (action !== "longText" || advanced.longText) &&
        (action !== "edit" || advanced.edit);
      const ready =
        advanced?.enabled &&
        access &&
        context.sharedBudget &&
        advanced.priceVersion &&
        advanced.postMaxMicros !== undefined &&
        (!media || advanced.mediaMaxMicros !== undefined);
      return {
        ...base(
          action,
          !permission || (media && !scopes.has("media.write"))
            ? "awaiting_permission"
            : ready
              ? "supported"
              : "temporarily_unavailable",
          media
            ? (advanced?.mediaMaxMicros ?? null)
            : (advanced?.postMaxMicros ?? null),
          media ? [...publishScopes, "media.write"] : publishScopes,
          ready
            ? "Review explicit publishing choices from your published MOH post."
            : "Confirm account access and maximum request costs before enabling.",
        ),
        priceVersion: advanced?.priceVersion || null,
      };
    }),
    {
      ...base(
        "article",
        context.article?.enabled && permission && context.sharedBudget
          ? "supported"
          : "unknown",
        context.article?.cost ?? null,
        publishScopes,
        context.article?.enabled
          ? null
          : "Native Articles need confirmed account access and pricing.",
      ),
      priceVersion: context.article?.priceVersion ?? null,
    },
    base(
      "delete",
      permission ? "supported" : "awaiting_permission",
      X_REFERENCE_PRICES.manageContent,
    ),
  ];
}
