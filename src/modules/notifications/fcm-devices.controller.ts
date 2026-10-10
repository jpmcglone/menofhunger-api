import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { AuthGuard, type AuthedRequest } from "../auth/auth-public-api";
import { FcmPushService } from "./fcm-push.service";
import type { FcmRegistrationDto } from "../../common/dto/fcm-device.dto";
import {
  rateLimitLimit,
  rateLimitTtl,
} from "../../common/throttling/rate-limit.resolver";

export const fcmRegisterSchema = z
  .object({
    installationId: z.string().uuid(),
    token: z.string().trim().min(1).max(4096),
    notificationsEnabled: z.boolean(),
  })
  .strict();

export const fcmUnregisterSchema = z
  .object({
    installationId: z.string().uuid(),
    bindingId: z.string().uuid(),
  })
  .strict();

@Controller("notifications/fcm")
@UseGuards(AuthGuard)
@Throttle({
  default: {
    limit: rateLimitLimit("interact", 180),
    ttl: rateLimitTtl("interact", 60),
  },
})
export class FcmDevicesController {
  constructor(private readonly fcm: FcmPushService) {}

  @Post("register")
  async register(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<{ data: FcmRegistrationDto }> {
    const data = await this.fcm.register(
      req.user,
      fcmRegisterSchema.parse(body),
    );
    return { data };
  }

  @Post("unregister")
  async unregister(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<{ data: Record<string, never> }> {
    await this.fcm.unregister(req.user, fcmUnregisterSchema.parse(body));
    return { data: {} };
  }
}
