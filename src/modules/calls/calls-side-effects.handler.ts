import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { CallVoipPushPayloadDto } from '../../common/dto/call.dto';
import { toUserListDto } from '../../common/dto/user.dto';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { AppConfigService } from '../app/app-config.service';
import { ApnsPushService } from '../notifications/apns-push.service';
import { PrismaService } from '../prisma/prisma.service';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { CallSessionStore } from './call-session.store';
import { CALL_RING_TIMEOUT_MS } from './calls.constants';

/**
 * Off-request-path work for calls. Today that is one thing: the PushKit ring that lets an
 * iPhone show the native CallKit screen even when the app is suspended or terminated.
 *
 * There is deliberately no "cancel" push: Apple requires every VoIP push to report an
 * incoming call, so the phone learns about answered-elsewhere / declined / timed-out over
 * the socket after PushKit wakes it (or from `call_not_found` when it tries to join).
 */
@Injectable()
export class CallsSideEffectsHandler implements OnModuleInit {
  private readonly logger = new Logger(CallsSideEffectsHandler.name);

  constructor(
    private readonly registry: SideEffectsRegistry,
    private readonly store: CallSessionStore,
    private readonly prisma: PrismaService,
    private readonly apns: ApnsPushService,
    private readonly appConfig: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register('call.direct.ringing', (p) => this.onDirectRinging(p));
  }

  async onDirectRinging(payload: SideEffectPayloads['call.direct.ringing']): Promise<void> {
    if (!this.apns.configured()) return;
    // Re-read: a retry after the callee already answered or declined must not ring them again.
    const record = await this.store.getByCallId(payload.callId);
    if (!record || record.status !== 'ringing' || record.ringTargetUserId !== payload.calleeUserId) return;
    if (!(await this.apns.hasVoipToken(payload.calleeUserId))) return;

    const callerRow = await this.prisma.user.findUnique({ where: { id: payload.callerUserId }, select: USER_LIST_SELECT });
    if (!callerRow) return;
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const startedAt = new Date(record.startedAt).getTime();
    const voip: CallVoipPushPayloadDto = {
      callId: record.id,
      conversationId: record.conversationId,
      type: record.type,
      caller: toUserListDto(callerRow, publicBaseUrl),
      expiresAt: new Date((Number.isFinite(startedAt) ? startedAt : Date.now()) + CALL_RING_TIMEOUT_MS).toISOString(),
    };
    try {
      await this.apns.sendVoip(payload.calleeUserId, voip);
    } catch (err) {
      this.logger.warn(`[calls] voip push failed call=${record.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
