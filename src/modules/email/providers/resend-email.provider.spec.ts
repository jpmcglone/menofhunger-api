import { ResendEmailProvider } from './resend-email.provider';

describe('Resend REST delivery boundary', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  const provider = () => new ResendEmailProvider({ email: () => ({ provider: 'resend', apiKey: 'fake', fromEmail: { default: 'MOH <support@example.com>' } }) } as never);
  const request = { to: 'member@example.com', subject: 'You are in', text: 'Hello', idempotencyKey: 'logical-send' };

  it('sends the stable key as an API header and records the accepted provider message ID', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 })) as never;
    await expect(provider().sendEmail(request)).resolves.toEqual({ sent: true, providerMessageId: 'provider-id' });
    expect(global.fetch).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({ headers: expect.objectContaining({ 'Idempotency-Key': 'logical-send' }), signal: expect.any(AbortSignal) }));
  });

  it('does not lose tracking when an acceptance response lacks its message ID', async () => {
    global.fetch = jest.fn(async () => new Response('{}', { status: 200 })) as never;
    expect(await provider().sendEmail(request)).toEqual({ sent: false, reason: 'resend_response_invalid', retryable: true });
  });

  it.each([429, 500, 503])('marks HTTP %i as transient', async status => {
    global.fetch = jest.fn(async () => new Response('{}', { status })) as never;
    expect(await provider().sendEmail(request)).toEqual({ sent: false, reason: 'resend_failed', retryable: true, definitiveRejection: status === 429 });
  });

  it.each([400, 401, 422])('does not retry permanent HTTP %i failure', async status => {
    global.fetch = jest.fn(async () => new Response('{}', { status })) as never;
    expect(await provider().sendEmail(request)).toEqual({ sent: false, reason: 'resend_failed', retryable: false, definitiveRejection: true });
  });

  it('retries a network failure using the original immutable request', async () => {
    global.fetch = jest.fn(async () => { throw new TypeError('fetch failed'); }) as never;
    expect(await provider().sendEmail(request)).toEqual({ sent: false, reason: 'email_failed', retryable: true });
  });
});
