import { ChannelMarvScopeService } from './channel-marv-scope.service';

const input = { groupId: 'group-a', channelId: 'chan', messageId: 'trigger', requesterId: 'human' };

function setup(opts: { body?: string; parent?: { body: string; senderId: string } | null; replyToId?: string | null; probability?: number | null; inChannel?: boolean; others?: string[]; privacy?: 'normal' | 'private'; invited?: boolean; lastOther?: { body: string; senderId: string } | null } = {}) {
  const trigger = { body: opts.body ?? 'can you explain that more', replyToId: opts.replyToId === undefined ? 'marv-msg' : opts.replyToId, threadRootId: null, createdAt: new Date() };
  const parent = opts.parent === undefined ? { body: 'Here is the answer.', senderId: 'marv', sender: { username: 'marv', name: 'Marv' } } : opts.parent;
  const db = {
    user: { findFirst: jest.fn().mockResolvedValue({ id: 'marv', username: 'marv' }) },
    communityGroupMember: {
      findUnique: jest.fn().mockResolvedValue(opts.inChannel === false ? null : { status: 'active', createdAt: new Date(1) }),
      findMany: jest.fn().mockResolvedValue((opts.others ?? []).map(username => ({ user: { username } }))),
    },
    groupChannelAccess: { findUnique: jest.fn().mockResolvedValue(opts.invited ? { createdAt: new Date(2) } : null) },
    message: { findFirst: jest.fn().mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id === 'trigger' ? trigger : where.id ? parent : (opts.lastOther ?? null))) },
  };
  const access = { enabled: () => true, channel: jest.fn().mockResolvedValue({ channel: { id: 'chan', conversationId: 'conversation', archivedAt: null, privacy: opts.privacy ?? 'normal' } }) };
  const config = { groupChannels: () => ({ marvEnabled: true }), marvBot: () => ({ enabled: true, username: 'marv' }) };
  const addressing = { available: jest.fn(() => true), addressedToMarvProbability: jest.fn(async () => (opts.probability === undefined ? 0.95 : opts.probability)) };
  const service = new ChannelMarvScopeService(db as never, config as never, access as never, {} as never, addressing as never);
  return { service, addressing, db };
}

describe('MARV channel addressing', () => {
  it('answers a direct reply to a Marv message that has no @mention', async () => {
    const { service, addressing } = setup();
    await expect(service.addressing(input)).resolves.toBe('jev');
    expect(addressing.addressedToMarvProbability).toHaveBeenCalledWith(expect.objectContaining({
      text: 'can you explain that more',
      parent: { text: 'Here is the answer.', authorIsMarv: true, authorIsSpeaker: false },
    }));
  });

  it('treats an unnamed follow-up right after a Marv message as a candidate, but not after a person', async () => {
    const followUp = setup({ replyToId: null, parent: null, body: 'what are you doing today?', lastOther: { body: 'Hi.', senderId: 'marv' } });
    await expect(followUp.service.addressing(input)).resolves.toBe('jev');
    expect(followUp.addressing.addressedToMarvProbability).toHaveBeenCalledWith(expect.objectContaining({
      parent: { text: 'Hi.', authorIsMarv: true, authorIsSpeaker: false },
    }));
    const afterPerson = setup({ replyToId: null, parent: null, body: 'what are you doing today?', lastOther: { body: 'hey', senderId: 'bob' } });
    await expect(afterPerson.service.addressing(input)).resolves.toBeNull();
    expect(afterPerson.addressing.addressedToMarvProbability).not.toHaveBeenCalled();
  });

  it('needs an invitation only in a private channel', async () => {
    const privateNotInvited = setup({ privacy: 'private' });
    await expect(privateNotInvited.service.addressing(input)).resolves.toBeNull();
    expect(privateNotInvited.addressing.addressedToMarvProbability).not.toHaveBeenCalled();
    await expect(setup({ privacy: 'private', invited: true }).service.addressing(input)).resolves.toBe('jev');
  });

  it('never asks Jev when the answer is already certain', async () => {
    const plain = setup({ replyToId: null, parent: null, body: 'lunch anyone?' });
    await expect(plain.service.addressing(input)).resolves.toBeNull();
    const tagged = setup({ body: '@marv can you explain' });
    await expect(tagged.service.addressing(input)).resolves.toBeNull();
    const notHere = setup({ inChannel: false });
    await expect(notHere.service.addressing(input)).resolves.toBeNull();
    const toHuman = setup({ parent: { body: 'hi', senderId: 'bob' }, body: 'you are right' });
    await expect(toHuman.service.addressing(input)).resolves.toBeNull();
    for (const s of [plain, tagged, notHere, toHuman]) expect(s.addressing.addressedToMarvProbability).not.toHaveBeenCalled();
  });

  it('considers the bare name Marv in a channel, and tells Jev about a different Marv', async () => {
    const { service, addressing } = setup({ replyToId: null, parent: null, body: 'Marv, what is the verse?', others: ['marvin_k'] });
    await expect(service.addressing(input)).resolves.toBe('jev');
    expect(addressing.addressedToMarvProbability).toHaveBeenCalledWith(expect.objectContaining({ parent: null, otherMarvs: ['marvin_k'] }));
  });

  it('stays quiet when Jev is unsure, absent, or says it is about Marv', async () => {
    await expect(setup({ probability: 0.3 }).service.addressing(input)).resolves.toBeNull();
    await expect(setup({ probability: null }).service.addressing(input)).resolves.toBeNull();
    await expect(setup({ probability: 0.02, replyToId: null, parent: null, body: 'Marv was wrong earlier' }).service.addressing(input)).resolves.toBeNull();
  });

  it('authorizes an untagged trigger only once the worker marks it addressed', async () => {
    const { service, db } = setup({ body: 'can you explain that more' });
    Object.assign(db, {
      user: { findUnique: jest.fn().mockResolvedValue({ premium: true }), findFirst: db.user.findFirst },
      marvinUserSettings: { findUnique: jest.fn().mockResolvedValue({ aiConsentAt: new Date(), aiConsentVersion: 2 }) },
    });
    db.communityGroupMember.findUnique.mockResolvedValue({ status: 'active', role: 'member', createdAt: new Date(1) });
    db.groupChannelAccess.findUnique.mockResolvedValue({ channelId: 'chan', createdAt: new Date(2) });
    db.message.findFirst.mockResolvedValue({ id: 'trigger', body: 'can you explain that more', conversationId: 'conversation' });
    await expect(service.authorize(input)).rejects.toThrow();
    await expect(service.authorize({ ...input, addressedBy: 'jev' })).resolves.toBeDefined();
  });
});
