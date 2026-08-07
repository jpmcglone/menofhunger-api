import { Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AdminGuard, type AdminRequest } from './admin.guard';
import { ApnsPushService } from '../notifications/apns-push.service';
import { NotificationPushService } from '../notifications/notification-push.service';

/**
 * Admin-only endpoints to fire a test push on a specific channel.
 *
 * Useful when validating push credentials, certificate environments, or
 * subscriber counts without waiting for a real notification event.
 *
 * Both endpoints send to the requesting admin's own account only.
 */
@UseGuards(AdminGuard)
@Controller('admin/push')
export class AdminPushController {
  constructor(
    private readonly apns: ApnsPushService,
    private readonly push: NotificationPushService,
  ) {}

  /** Send a test push via APNs (native iOS) to the admin's registered devices. */
  @Post('test/apns')
  async testApns(@Req() req: AdminRequest): Promise<{ data: { sent: boolean; message?: string } }> {
    const userId = req.user?.id ?? '';

    if (!this.apns.configured()) {
      return { data: { sent: false, message: 'APNs is not configured on this server (missing APNS_* env vars).' } };
    }

    const hasTokens = await this.apns.hasTokens(userId);
    if (!hasTokens) {
      return {
        data: {
          sent: false,
          message:
            'No APNs device tokens registered for your account. Open the app on a real device, allow notifications, and try again.',
        },
      };
    }

    const results = await this.apns.sendDiagnosticToUser(userId, {
      title: 'Test iOS push',
      body: 'APNs is working.',
      url: '/notifications',
    });

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    if (succeeded.length > 0 && failed.length === 0) {
      return { data: { sent: true } };
    }

    if (succeeded.length > 0) {
      const errDetail = failed.map((r) => `[…${r.token}/${r.environment}] ${r.error}`).join('; ');
      return {
        data: {
          sent: true,
          message: `Delivered to ${succeeded.length} device(s). ${failed.length} failed: ${errDetail}`,
        },
      };
    }

    const errDetail = failed.map((r) => `[…${r.token}/${r.environment}] ${r.error}`).join('; ');
    return {
      data: {
        sent: false,
        message: `APNs delivery failed on all ${failed.length} device(s): ${errDetail}`,
      },
    };
  }

  /** Send a test push via Web Push (VAPID) to the admin's browser subscriptions. */
  @Post('test/web')
  async testWeb(@Req() req: AdminRequest): Promise<{ data: { sent: boolean; message?: string } }> {
    const result = await this.push.sendTestPush(req.user?.id ?? '');
    return { data: result };
  }
}
