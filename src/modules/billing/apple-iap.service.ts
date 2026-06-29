import { Injectable, Logger, UnprocessableEntityException, ServiceUnavailableException } from '@nestjs/common';
import {
  SignedDataVerifier,
  Environment,
  type JWSTransactionDecodedPayload,
  type JWSRenewalInfoDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService, type AppleIapConfig } from '../app/app-config.service';
import { EntitlementService } from './entitlement.service';
import type { BillingMeDto } from '../../common/dto';
import { BillingService } from './billing.service';
import { APPLE_ROOT_CERTIFICATES } from './apple-root-certs';

const AUTO_RENEWABLE_SUBSCRIPTION = 'Auto-Renewable Subscription';
/** Apple's AutoRenewStatus.ON. */
const AUTO_RENEW_ON = 1;

const ACTIVE_ASSN_TYPES = new Set([
  'SUBSCRIBED',
  'DID_RENEW',
  'OFFER_REDEEMED',
]);

const EXPIRED_ASSN_TYPES = new Set([
  'EXPIRED',
  'REVOKED',
]);

@Injectable()
export class AppleIapService {
  private readonly logger = new Logger(AppleIapService.name);

  /** Cached verifiers keyed by environment; built lazily on first use. */
  private readonly verifiers = new Map<Environment, SignedDataVerifier>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly entitlement: EntitlementService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Build (and cache) a verifier for one App Store environment. Returns null when
   * the environment can't be verified with the current config — production requires
   * the numeric appAppleId, so without it we only support sandbox.
   */
  private getVerifier(cfg: AppleIapConfig, environment: Environment): SignedDataVerifier | null {
    if (environment === Environment.PRODUCTION && cfg.appAppleId === null) return null;

    const cached = this.verifiers.get(environment);
    if (cached) return cached;

    const verifier = new SignedDataVerifier(
      APPLE_ROOT_CERTIFICATES,
      true, // online revocation/expiration checks
      environment,
      cfg.bundleId,
      cfg.appAppleId ?? undefined,
    );
    this.verifiers.set(environment, verifier);
    return verifier;
  }

  /**
   * Run a verify-and-decode against the configured environment first, falling back
   * to the other environment. This keeps verification working during App Review,
   * when Apple issues Sandbox transactions/notifications against a production app.
   * Throws if neither environment can verify the signature.
   */
  private async verifyAgainstEnvironments<T>(
    cfg: AppleIapConfig,
    run: (verifier: SignedDataVerifier) => Promise<T>,
  ): Promise<T> {
    const primary = cfg.environment === 'production' ? Environment.PRODUCTION : Environment.SANDBOX;
    const secondary = primary === Environment.PRODUCTION ? Environment.SANDBOX : Environment.PRODUCTION;

    let lastError: unknown;
    for (const environment of [primary, secondary]) {
      const verifier = this.getVerifier(cfg, environment);
      if (!verifier) continue;
      try {
        return await run(verifier);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error('No Apple signed-data verifier available.');
  }

  /**
   * Verify a signed transaction JWS posted from the iOS client via `POST /billing/apple/verify`.
   * Apple's `SignedDataVerifier` validates the certificate chain, signature, bundle id, and
   * environment before we trust any field. Upserts Apple sub state, recomputes effective tier,
   * returns updated BillingMe.
   */
  async verifyTransaction(userId: string, signedTransaction: string): Promise<BillingMeDto> {
    const cfg = this.appConfig.appleIap();
    if (!cfg) {
      throw new ServiceUnavailableException('Apple IAP is not configured on this server.');
    }

    let txn: JWSTransactionDecodedPayload;
    try {
      txn = await this.verifyAgainstEnvironments(cfg, (v) => v.verifyAndDecodeTransaction(signedTransaction));
    } catch (err) {
      this.logger.warn(`[apple-iap] Transaction verification failed for user ${userId}: ${String(err)}`);
      throw new UnprocessableEntityException('Could not verify signed transaction.');
    }

    if (txn.type !== AUTO_RENEWABLE_SUBSCRIPTION) {
      throw new UnprocessableEntityException(`Unexpected product type: ${txn.type ?? 'unknown'}`);
    }

    if (!txn.productId || !txn.originalTransactionId) {
      throw new UnprocessableEntityException('Verified transaction is missing required fields.');
    }

    const tier = cfg.productTierMap[txn.productId];
    if (!tier) {
      throw new UnprocessableEntityException(`Unknown productId: ${txn.productId}. Not in tier map.`);
    }

    const expiresAt = txn.expiresDate ? new Date(txn.expiresDate) : null;
    const isActive = expiresAt ? expiresAt > new Date() : false;

    await this.upsertAppleSub({
      originalTransactionId: txn.originalTransactionId,
      productId: txn.productId,
      status: isActive ? 'active' : 'expired',
      expiresAt,
      // A just-purchased subscription auto-renews by default; ASSN events keep this in sync.
      autoRenew: isActive,
      environment: txn.environment ?? cfg.environment,
      userId,
    });

    await this.entitlement.recomputeAndApply(userId);
    return this.billing.getMe(userId);
  }

  /**
   * Handle an App Store Server Notification V2 (JWS-signed, CSRF-excluded webhook).
   * Apple sends these for subscription lifecycle events (renewals, expirations, refunds).
   */
  async handleNotification(signedPayload: string): Promise<void> {
    const cfg = this.appConfig.appleIap();
    if (!cfg) {
      this.logger.warn('[apple-iap] Received ASSN but Apple IAP is not configured.');
      return;
    }

    let notification: ResponseBodyV2DecodedPayload;
    try {
      notification = await this.verifyAgainstEnvironments(cfg, (v) => v.verifyAndDecodeNotification(signedPayload));
    } catch (err) {
      this.logger.warn(`[apple-iap] Could not verify ASSN payload — ignoring. ${String(err)}`);
      return;
    }

    const { notificationType, subtype, data } = notification;
    this.logger.log(`[apple-iap] ASSN type=${notificationType ?? ''} subtype=${subtype ?? ''}`);

    if (!data?.signedTransactionInfo) {
      this.logger.log('[apple-iap] No signedTransactionInfo — nothing to do.');
      return;
    }

    let txn: JWSTransactionDecodedPayload;
    try {
      txn = await this.verifyAgainstEnvironments(cfg, (v) =>
        v.verifyAndDecodeTransaction(data.signedTransactionInfo as string),
      );
    } catch (err) {
      this.logger.warn(`[apple-iap] Could not verify signedTransactionInfo. ${String(err)}`);
      return;
    }

    if (!txn.originalTransactionId) {
      this.logger.warn('[apple-iap] Verified transaction is missing originalTransactionId.');
      return;
    }

    const user = await this.prisma.user.findFirst({
      where: { appleOriginalTransactionId: txn.originalTransactionId },
      select: { id: true },
    });

    if (!user) {
      this.logger.warn(`[apple-iap] No user found for originalTransactionId=${txn.originalTransactionId}`);
      return;
    }

    const expiresAt = txn.expiresDate ? new Date(txn.expiresDate) : null;
    const now = new Date();

    let status: string;
    if (notificationType && ACTIVE_ASSN_TYPES.has(notificationType)) {
      status = 'active';
    } else if (notificationType && EXPIRED_ASSN_TYPES.has(notificationType)) {
      status = 'expired';
    } else {
      // DID_FAIL_TO_RENEW, GRACE_PERIOD_EXPIRED, etc.
      status = expiresAt && expiresAt > now ? 'active' : 'expired';
    }

    let autoRenew = false;
    if (data.signedRenewalInfo) {
      try {
        const renewal: JWSRenewalInfoDecodedPayload = await this.verifyAgainstEnvironments(cfg, (v) =>
          v.verifyAndDecodeRenewalInfo(data.signedRenewalInfo as string),
        );
        autoRenew = renewal.autoRenewStatus === AUTO_RENEW_ON;
      } catch {
        // non-fatal — renewal info is optional for status tracking
      }
    }

    await this.upsertAppleSub({
      originalTransactionId: txn.originalTransactionId,
      productId: txn.productId ?? '',
      status,
      expiresAt,
      autoRenew,
      environment: data.environment ?? txn.environment ?? cfg.environment,
      userId: user.id,
    });

    await this.entitlement.recomputeAndApply(user.id);
    this.logger.log(`[apple-iap] Recomputed entitlement for user ${user.id} after ${notificationType ?? 'notification'}`);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async upsertAppleSub(params: {
    originalTransactionId: string;
    productId: string;
    status: string;
    expiresAt: Date | null;
    autoRenew: boolean;
    environment: string;
    userId: string;
  }) {
    await this.prisma.user.update({
      where: { id: params.userId },
      data: {
        appleOriginalTransactionId: params.originalTransactionId,
        appleProductId: params.productId,
        appleStatus: params.status,
        appleExpiresAt: params.expiresAt,
        appleAutoRenew: params.autoRenew,
        appleEnvironment: params.environment,
      },
    });
  }
}
