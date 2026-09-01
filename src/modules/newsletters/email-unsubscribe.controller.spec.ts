import { EmailUnsubscribeController } from './email-unsubscribe.controller';
import type { AppConfigService } from '../app/app-config.service';
import type { NewslettersService } from './newsletters.service';

describe('EmailUnsubscribeController', () => {
  function makeController() {
    const newsletters = {
      unsubscribeWithToken: jest.fn(async () => ({ ok: true })),
    };
    const appConfig = {
      frontendBaseUrl: () => 'https://menofhunger.com',
    };
    const res = { redirect: jest.fn() };
    const controller = new EmailUnsubscribeController(
      newsletters as unknown as NewslettersService,
      appConfig as unknown as AppConfigService,
    );
    return { controller, newsletters, res };
  }

  it('GET redirects to the site with the token and does not unsubscribe', () => {
    const { controller, newsletters, res } = makeController();
    controller.unsubscribeGet('tok+1', res as never);
    expect(newsletters.unsubscribeWithToken).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://menofhunger.com/email/unsubscribe?token=tok%2B1',
    );
  });

  it('GET without a token still lands on the site page', () => {
    const { controller, newsletters, res } = makeController();
    controller.unsubscribeGet(undefined, res as never);
    expect(newsletters.unsubscribeWithToken).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://menofhunger.com/email/unsubscribe');
  });

  it('POST unsubscribes newsletters only via the token', async () => {
    const { controller, newsletters } = makeController();
    await expect(controller.unsubscribePost('from-query', { token: 'from-body' })).resolves.toEqual({
      data: { ok: true },
    });
    expect(newsletters.unsubscribeWithToken).toHaveBeenCalledWith('from-body');
  });
});
