import { MarvinJevService } from './marvin-jev.service';

function makeService(opts: { configured?: boolean; routing?: boolean; gate?: boolean; result?: unknown } = {}) {
  const typeSafe: any = {
    isConfigured: jest.fn(() => opts.configured ?? true),
    decide: jest.fn(async () => (opts.result === undefined ? null : opts.result)),
  };
  const appConfig: any = {
    typeSafe: jest.fn(() => ({ routingEnabled: opts.routing ?? true, replyGateEnabled: opts.gate ?? true })),
  };
  return { svc: new MarvinJevService(typeSafe, appConfig), typeSafe };
}

describe('MarvinJevService', () => {
  it('is unavailable without a key or when its switch is off, and never calls Jev', async () => {
    const noKey = makeService({ configured: false });
    expect(noKey.svc.routingAvailable()).toBe(false);
    await expect(noKey.svc.routingSignals({ text: 'hi', webSearchEnabled: true })).resolves.toBeNull();
    await expect(noKey.svc.replyExpectedProbability({ text: 'thanks' })).resolves.toBeNull();
    expect(noKey.typeSafe.decide).not.toHaveBeenCalled();

    const off = makeService({ routing: false, gate: false });
    await expect(off.svc.routingSignals({ text: 'hi', webSearchEnabled: true })).resolves.toBeNull();
    await expect(off.svc.replyExpectedProbability({ text: 'thanks' })).resolves.toBeNull();
    expect(off.typeSafe.decide).not.toHaveBeenCalled();
  });

  it('maps routing answers and hides web signals when search is disabled', async () => {
    const answers = {
      crisis: { noul: 0.1 },
      sensitive: { noul: 0.7 },
      explicitSearch: { noul: 0.9 },
      liveInfo: { noul: 0.8 },
      complexity: { choice: 'moderate', confidence: 0.75 },
    };
    const { svc, typeSafe } = makeService({ result: { answers } });
    await expect(svc.routingSignals({ text: 'hello', webSearchEnabled: true })).resolves.toEqual({
      crisis: 0.1,
      sensitive: 0.7,
      explicitSearch: 0.9,
      liveInfo: 0.8,
      complexity: { level: 'moderate', confidence: 0.75 },
    });
    await expect(svc.routingSignals({ text: 'hello', webSearchEnabled: false })).resolves.toMatchObject({
      explicitSearch: null,
      liveInfo: null,
    });
    const call = typeSafe.decide.mock.calls[0][0];
    expect(call.purpose).toBe('marv.routing');
    expect(call.timeoutMs).toBeLessThanOrEqual(3000);
    expect(call.state).toEqual({ message: 'hello' });
  });

  it('returns null so callers use rules when Jev fails', async () => {
    const { svc } = makeService({ result: null });
    await expect(svc.routingSignals({ text: 'hello', webSearchEnabled: true })).resolves.toBeNull();
  });

  it('includes the message being replied to for the reply gate', async () => {
    const { svc, typeSafe } = makeService({ result: { answers: { replyExpected: { noul: 0.02 } } } });
    await expect(
      svc.replyExpectedProbability({ text: 'thanks @marv', previous: { text: 'Here is the answer.', fromMarv: true } }),
    ).resolves.toBe(0.02);
    expect(typeSafe.decide.mock.calls[0][0].state).toEqual({
      message: 'thanks @marv',
      replyingTo: 'Here is the answer.',
      replyingToAuthor: 'Marv',
    });
  });
});
