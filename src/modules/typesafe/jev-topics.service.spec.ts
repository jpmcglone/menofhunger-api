import { JevTopicsService } from './jev-topics.service';

function service(answer: { choice: string; probabilities: Record<string, number> } | null, configured = true) {
  const decide = jest.fn(async () => (answer ? { answers: { topic: answer } } : null));
  const typeSafe = { isConfigured: () => configured, decide };
  return { jev: new JevTopicsService(typeSafe as never), decide };
}

describe('JevTopicsService', () => {
  it('returns the topics Jev gives real weight to, strongest first and capped', async () => {
    const { jev } = service({ choice: 'fitness', probabilities: { fitness: 0.6, health: 0.25, nutrition: 0.1, none: 0.05 } });
    await expect(jev.topicsFor('gym', 'search query')).resolves.toEqual(['fitness', 'health']);
  });

  it('returns no topics when Jev says none of them fit', async () => {
    const { jev } = service({ choice: 'none', probabilities: { none: 0.8, fitness: 0.2 } });
    await expect(jev.topicsFor('purple elephants', 'search query')).resolves.toEqual([]);
  });

  it('returns null, so callers keep their old behavior, when Jev is unavailable or silent', async () => {
    await expect(service(null, false).jev.topicsFor('gym', 'search query')).resolves.toBeNull();
    await expect(service(null).jev.topicsFor('gym', 'search query')).resolves.toBeNull();
    await expect(service(null).jev.topicsFor('   ', 'search query')).resolves.toBeNull();
  });

  it('answers a repeated query from memory', async () => {
    const { jev, decide } = service({ choice: 'fitness', probabilities: { fitness: 0.9 } });
    await jev.topicsFor('Gym', 'search query');
    await jev.topicsFor('gym', 'search query');
    expect(decide).toHaveBeenCalledTimes(1);
  });
});
