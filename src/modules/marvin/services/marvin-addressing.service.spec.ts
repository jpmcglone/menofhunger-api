import { MarvinAddressingService } from './marvin-addressing.service';

function make(opts: { configured?: boolean; enabled?: boolean; result?: unknown } = {}) {
  const typeSafe: any = {
    isConfigured: () => opts.configured ?? true,
    decide: jest.fn(async () => (opts.result === undefined ? null : opts.result)),
  };
  const appConfig: any = { typeSafe: () => ({ addressingEnabled: opts.enabled ?? true }) };
  return { svc: new MarvinAddressingService(typeSafe, appConfig), typeSafe };
}

describe('MarvinAddressingService', () => {
  it('has no opinion, and never calls Jev, when off or unconfigured', async () => {
    for (const opts of [{ configured: false }, { enabled: false }]) {
      const { svc, typeSafe } = make(opts);
      expect(svc.available()).toBe(false);
      await expect(svc.addressedToMarvProbability({ text: 'you there?' })).resolves.toBeNull();
      expect(typeSafe.decide).not.toHaveBeenCalled();
    }
  });

  it('labels who is being replied to so "you" can be resolved', async () => {
    const { svc, typeSafe } = make({ result: { answers: { addressedToMarv: { noul: 0.92 } } } });
    await expect(
      svc.addressedToMarvProbability({ text: 'can you explain', parent: { text: 'Done.', authorIsMarv: true, authorIsSpeaker: false } }),
    ).resolves.toBe(0.92);
    expect(typeSafe.decide.mock.calls[0][0].state.replyingToAuthor).toBe('Marv, the AI assistant');

    await svc.addressedToMarvProbability({ text: 'you', parent: { text: 'x', authorIsMarv: false, authorIsSpeaker: false } });
    expect(typeSafe.decide.mock.calls[1][0].state.replyingToAuthor).toBe('another member');
    await svc.addressedToMarvProbability({ text: 'Marv', parent: null });
    expect(typeSafe.decide.mock.calls[2][0].state.replyingToAuthor).toMatch(/new post/);
  });

  it('returns null when Jev fails', async () => {
    const { svc } = make({ result: null });
    await expect(svc.addressedToMarvProbability({ text: 'Marv?' })).resolves.toBeNull();
  });
});
