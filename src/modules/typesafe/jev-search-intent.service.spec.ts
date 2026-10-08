import { JevSearchIntentService } from './jev-search-intent.service';

function service(answers: { kind: string; recent: number } | null, configured = true) {
  const decide = jest.fn(async () =>
    answers ? { answers: { kind: { choice: answers.kind }, recent: { noul: answers.recent } } } : null,
  );
  return { jev: new JevSearchIntentService({ isConfigured: () => configured, decide } as never), decide };
}

describe('JevSearchIntentService', () => {
  it('reads the kind and recency intent of a query', async () => {
    const { jev } = service({ kind: 'topic', recent: 0.9 });
    await expect(jev.intentFor('latest on fasting')).resolves.toEqual({ kind: 'topic', wantsRecent: true });
  });

  it('ignores a weak recency signal', async () => {
    const { jev } = service({ kind: 'person', recent: 0.3 });
    await expect(jev.intentFor('john smith')).resolves.toEqual({ kind: 'person', wantsRecent: false });
  });

  it('returns null when Jev is unavailable or the query is tiny', async () => {
    await expect(service(null, false).jev.intentFor('fasting')).resolves.toBeNull();
    await expect(service(null).jev.intentFor('fasting')).resolves.toBeNull();
    await expect(service({ kind: 'topic', recent: 0 }).jev.intentFor('ab')).resolves.toBeNull();
  });

  it('answers a repeated query from memory', async () => {
    const { jev, decide } = service({ kind: 'phrase', recent: 0 });
    await jev.intentFor('Iron sharpens iron');
    await jev.intentFor('iron sharpens iron');
    expect(decide).toHaveBeenCalledTimes(1);
  });
});
