import { NotificationsController } from '../notifications/notifications.controller';
import { MessagesController } from '../messages/messages.controller';

/**
 * Endpoints that must go quiet while a site admin is impersonating.
 *
 * Both of these otherwise write state that a third party can observe — a push-device
 * binding and a read receipt — which would attribute the admin's debugging session to the
 * account they are looking at.
 */
describe('impersonation side-effect suppression', () => {
  describe('POST /notifications/apns/register', () => {
    function makeController() {
      const notifications = { apnsRegister: jest.fn(async () => undefined) } as any;
      return { controller: new NotificationsController(notifications), notifications };
    }

    const body = { token: 'device-token-abc', environment: 'sandbox' };

    it('registers the device for an ordinary session', async () => {
      const { controller, notifications } = makeController();

      const result = await controller.apnsRegister('user-1', false, body);

      expect(notifications.apnsRegister).toHaveBeenCalledWith('user-1', {
        token: 'device-token-abc',
        environment: 'sandbox',
        kind: 'alert',
      });
      expect(result).toEqual({ data: {} });
    });

    it('does not rebind the device while impersonating', async () => {
      const { controller, notifications } = makeController();

      // Device tokens are unique per device, so registering here would move the admin's
      // phone onto the target: the target's pushes would land on the admin's device and
      // the admin would stop receiving their own, outliving the impersonation session.
      const result = await controller.apnsRegister('target-1', true, body);

      expect(notifications.apnsRegister).not.toHaveBeenCalled();
      expect(result).toEqual({ data: {} });
    });

    it('still validates the body while impersonating', async () => {
      const { controller } = makeController();
      await expect(controller.apnsRegister('target-1', true, { token: '' })).rejects.toThrow();
    });
  });

  describe('POST /messages/conversations/:id/mark-read', () => {
    function makeController() {
      const messages = { markRead: jest.fn(async () => undefined) } as any;
      return { controller: new MessagesController(messages), messages };
    }

    it('marks the conversation read for an ordinary session', async () => {
      const { controller, messages } = makeController();

      const result = await controller.markRead('user-1', false, 'conv-1');

      expect(messages.markRead).toHaveBeenCalledWith({ userId: 'user-1', conversationId: 'conv-1' });
      expect(result).toEqual({ data: {} });
    });

    it('does not send a read receipt while impersonating', async () => {
      const { controller, messages } = makeController();

      const result = await controller.markRead('target-1', true, 'conv-1');

      expect(messages.markRead).not.toHaveBeenCalled();
      expect(result).toEqual({ data: {} });
    });
  });
});
