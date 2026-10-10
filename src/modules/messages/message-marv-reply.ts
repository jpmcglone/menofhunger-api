import type { MessageConversation } from "@prisma/client";
import type { AppConfigService } from "../app/app-config.service";
import type { JobsService } from "../jobs/jobs.service";
import { JOBS } from "../jobs/jobs.constants";
import type { MessagesSupportService } from "./messages-support.service";

export async function enqueueMessageMarvReply(
  appConfig: AppConfigService,
  support: MessagesSupportService,
  jobs: JobsService,
  params: {
    userId: string;
    conversationId: string;
    messageId: string;
    conversationType: MessageConversation["type"];
    otherIds: string[];
    body: string;
  },
) {
  const {
    userId,
    conversationId,
    messageId,
    conversationType,
    otherIds,
    body,
  } = params;
  // ─── Marv: queue an AI reply when this DM is for the configured Marv bot ──
  // Decoupled from MarvinModule — we only enqueue. The processor handles all gating.
  // Resolve Marv's user id via the identity service (env var optional) so the gate
  // doesn't silently skip when `MARV_USER_ID` isn't pinned in `.env`.
  try {
    const marvCfg = appConfig.marvBot();
    const marvUserId = marvCfg.enabled
      ? await support.resolveMarvUserId()
      : null;
    const isDirect = conversationType === "direct";
    const recipientIsMarv =
      !!marvUserId && otherIds.length === 1 && otherIds[0] === marvUserId;
    const senderIsMarv = !!marvUserId && userId === marvUserId;
    const hasBody = body.length > 0;

    if (!marvCfg.enabled) {
      support.logger.log(
        `[marv] dm-enqueue skip reason=marv_disabled msg=${messageId}`,
      );
    } else if (!marvUserId) {
      support.logger.warn(
        `[marv] dm-enqueue skip reason=marv_user_unresolved msg=${messageId}`,
      );
    } else if (!isDirect) {
      // Group chat or wall — never enqueue for Marv. No log needed; spammy.
    } else if (!recipientIsMarv) {
      // DM to someone else — silent skip.
    } else if (senderIsMarv) {
      support.logger.log(
        `[marv] dm-enqueue skip reason=sender_is_marv msg=${messageId}`,
      );
    } else if (!hasBody) {
      support.logger.log(
        `[marv] dm-enqueue skip reason=empty_body msg=${messageId}`,
      );
    } else {
      support.logger.log(
        `[marv] dm-enqueue HIT msg=${messageId} convo=${conversationId} sender=${userId}`,
      );
      await jobs
        .enqueue(
          JOBS.marvinReplyPrivate,
          {
            conversationId,
            messageId,
            requestingUserId: userId,
            requestedMode: null,
          },
          {
            jobId: `marv-private-${messageId}`,
            removeOnComplete: true,
            removeOnFail: false,
            attempts: 3,
            backoff: { type: "exponential" as const, delay: 5000 },
          },
        )
        .then(() => {
          support.logger.log(
            `[marv] dm-enqueue ok msg=${messageId} job=marv-private-${messageId}`,
          );
        })
        .catch((err) => {
          support.logger.warn(
            `[marv] Failed to enqueue private reply for message=${messageId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }
  } catch (err) {
    support.logger.warn(
      `[marv] private-reply enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
