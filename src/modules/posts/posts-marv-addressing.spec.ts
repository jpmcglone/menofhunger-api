import { makePostsSideEffectsHandler } from './posts-side-effects.testing';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { MarvinAddressingService } from '../marvin/services/marvin-addressing.service';

const MARV = 'marv-id';

function setup(opts: { probability?: number | null; available?: boolean; parent?: { body: string; userId: string; user?: { username: string; name: string } } | null } = {}) {
  const addressedToMarvProbability = jest.fn(async () => (opts.probability === undefined ? 0.95 : opts.probability));
  const addressing: any = { available: () => opts.available ?? true, addressedToMarvProbability };
  const prisma: any = {
    post: { findFirst: jest.fn(async () => (opts.parent === undefined ? { body: 'Here is my answer.', userId: MARV, user: { username: 'marv', name: 'Marv' } } : opts.parent)) },
    communityGroupMember: { findUnique: jest.fn(async () => null) },
  };
  const jobs: any = { enqueue: jest.fn(async () => undefined) };
  const handler = makePostsSideEffectsHandler(
    prisma,
    {} as any,
    { emitPostsTyping: jest.fn() } as any,
    { marvBot: () => ({ enabled: true, username: 'marv', userId: MARV }) } as any,
    jobs,
    { cachedMarvUserId: () => MARV, getMarvUserId: async () => MARV } as any,
    {} as any,
    new SideEffectsRegistry(),
    {} as any,
    {} as any,
    addressing,
  );
  const run = (post: Record<string, unknown>, actorUserId = 'alice') =>
    (handler as any).createdEffects.maybeEnqueueMarvReply({
      post: { id: 'p-1', kind: 'regular', rootId: 'r-1', communityGroupId: null, mentions: [], parentId: 'p-0', ...post },
      actorUserId,
      bodySnippet: '',
      visibility: 'public',
      requestedMarvMode: null,
    });
  return { run, jobs, addressedToMarvProbability };
}

describe('untagged posts addressed to Marv', () => {
  it('answers a reply to Marv that says "you" with no @mention', async () => {
    const { run, jobs, addressedToMarvProbability } = setup();
    await run({ body: 'can you tell me what that website is about' });
    expect(addressedToMarvProbability).toHaveBeenCalledWith({
      text: 'can you tell me what that website is about',
      otherMarvs: [],
      parent: { text: 'Here is my answer.', authorIsMarv: true, authorIsSpeaker: false },
    });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      'marvin.reply.public',
      expect.objectContaining({ postId: 'p-1', requestingUserId: 'alice', addressedBy: 'jev' }),
      expect.anything(),
    );
  });

  it('does not ask Jev about ordinary posts', async () => {
    const { run, jobs, addressedToMarvProbability } = setup({ parent: { body: 'hello', userId: 'bob' } });
    await run({ body: 'you are right about that' });
    await run({ body: 'a brand new post', parentId: null });
    expect(addressedToMarvProbability).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('tells Jev when the person being replied to is a different Marv', async () => {
    const { run, addressedToMarvProbability } = setup({ parent: { body: 'hello', userId: 'bob', user: { username: 'marvin_k', name: 'Marvin K' } }, probability: 0.1 });
    await run({ body: 'Marv, can you send it?' });
    expect(addressedToMarvProbability).toHaveBeenCalledWith(expect.objectContaining({ otherMarvs: ['marvin_k'] }));
  });

  it('considers the bare name "Marv" even on a reply to someone else, and trusts Jev on talking about him', async () => {
    const about = setup({ parent: { body: 'hello', userId: 'bob' }, probability: 0.03 });
    await about.run({ body: 'Marv got that wrong yesterday' });
    expect(about.addressedToMarvProbability).toHaveBeenCalled();
    expect(about.jobs.enqueue).not.toHaveBeenCalled();

    const to = setup({ parent: { body: 'hello', userId: 'bob' }, probability: 0.97 });
    await to.run({ body: 'Marv, what do you think about this?' });
    expect(to.jobs.enqueue).toHaveBeenCalled();
  });

  it('stays quiet when Jev is unsure, unavailable, or returns nothing', async () => {
    for (const opts of [{ probability: 0.4 }, { available: false }, { probability: null }]) {
      const { run, jobs } = setup(opts);
      await run({ body: 'what do you think?' });
      expect(jobs.enqueue).not.toHaveBeenCalled();
    }
  });

  it('never fires on Marv\'s own posts or on board posts', async () => {
    const own = setup();
    await own.run({ body: 'you are welcome' }, MARV);
    expect(own.jobs.enqueue).not.toHaveBeenCalled();
    const board = setup();
    await board.run({ kind: 'board', body: 'what do you think?' });
    expect(board.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('flags only a bare name and replies to Marv as candidates', () => {
    expect(MarvinAddressingService.isCandidate('Marv, thoughts?', false)).toBe(true);
    expect(MarvinAddressingService.isCandidate('what do you think', true)).toBe(true);
    expect(MarvinAddressingService.isCandidate('what do you think', false)).toBe(false);
    expect(MarvinAddressingService.isCandidate('marvelous work', false)).toBe(false);
    expect(MarvinAddressingService.isCandidate('email me@marv.com', false)).toBe(false);
  });
});
