import { createHmac } from 'node:crypto';
import { isPublicWebhookAddress, webhookSignature } from './partner-webhook.transport';

describe('partner webhook boundaries', () => {
  it.each(['127.0.0.1', '10.2.3.4', '169.254.169.254', '100.64.0.1', '172.16.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::'])('rejects private/special address %s', address => expect(isPublicWebhookAddress(address)).toBe(false));
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('allows public address %s', address => expect(isPublicWebhookAddress(address)).toBe(true));
  it('signs exact raw body bytes with a timestamp', () => {
    const body = '{ "id": "synthetic-event" }';
    expect(webhookSignature(body, '123', 'secret')).toBe(createHmac('sha256', 'secret').update(`123.${body}`).digest('hex'));
    expect(webhookSignature(body, '123', 'secret')).not.toBe(webhookSignature(JSON.stringify(JSON.parse(body)), '123', 'secret'));
  });
});
