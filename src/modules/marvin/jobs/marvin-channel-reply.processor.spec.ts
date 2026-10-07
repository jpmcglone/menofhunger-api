import { NotFoundException } from '@nestjs/common';
import { MarvinChannelReplyProcessor } from './marvin-channel-reply.processor';
const input = { groupId: 'group', channelId: 'channel', messageId: 'trigger', requesterId: 'human' };
function setup() {
  const db = {
    user: { findUnique: jest.fn().mockResolvedValue({ premium: true, username: 'human' }) },
    marvinUserSettings: { findUnique: jest.fn().mockResolvedValue({ aiConsentAt: new Date(), aiConsentVersion: 2 }) },
    marvinIdempotencyKey: { create: jest.fn(), deleteMany: jest.fn() }, message: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const config = { groupChannels: () => ({}), marvBot: () => ({ username: 'marv' }), marvLimits: () => ({ privateMaxPer10Minutes: 10, privateMaxPerUserPerDay: 100 }) };
  const authorized = { grant: { botId: 'marv', invitation: 'one' }, channel: { conversationId: 'conversation' }, trigger: { body: '@marv help' } };
  const scope = { addressing: jest.fn().mockResolvedValue(null), authorize: jest.fn().mockResolvedValue(authorized), retrieve: jest.fn().mockResolvedValue([]), validateEvidence: jest.fn().mockResolvedValue(authorized) };
  const credits = { resolveCreditOwnerId: jest.fn().mockResolvedValue('owner'), costForMode: () => 2, threadContextSurcharge: (count: number) => count,
    reserve: jest.fn(), settle: jest.fn().mockResolvedValue({}), refund: jest.fn().mockResolvedValue({}) };
  const usage = { countRecent: jest.fn().mockResolvedValue(0), recordEvent: jest.fn(), emitCreditsUpdated: jest.fn() };
  const routing = { resolve: () => ({ mode: 'fast', reason: 'auto' }), estimateTokens: () => 5 };
  const ai = { respond: jest.fn(async (_request: { signal: AbortSignal }) => ({ text: 'An answer.' })) };
  const messages = { broadcast: jest.fn() }, effects = { dispatch: jest.fn() };
  const presence = { emitGroupChannelTyping: jest.fn() };
  const processor = new MarvinChannelReplyProcessor(db as never, config as never, scope as never, {} as never, messages as never, {} as never, effects as never, credits as never, routing as never, ai as never, usage as never, presence as never);
  const deliver = jest.spyOn(processor as never, 'deliver' as never).mockResolvedValue({ id: 'reply', created: true } as never);
  return { processor, db, scope, credits, ai, deliver, effects, usage, presence };
}
describe('MARV channel generation lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { expect(jest.getTimerCount()).toBe(0); jest.useRealTimers(); });
  it('releases the job claim and heartbeat when credit owner resolution fails', async () => {
    const { processor, credits, db } = setup(); credits.resolveCreditOwnerId.mockRejectedValue(new Error('resolution failed'));
    await expect(processor.process(input)).rejects.toThrow('resolution failed');
    expect(db.marvinIdempotencyKey.deleteMany).toHaveBeenCalled(); expect(credits.reserve).not.toHaveBeenCalled();
  });
  it('refunds reserved credits and never posts after source revocation', async () => {
    const { processor, scope, credits, deliver } = setup(); scope.validateEvidence.mockRejectedValue(new NotFoundException());
    await processor.process(input);
    expect(credits.refund).toHaveBeenCalledWith('owner', 62); expect(deliver).not.toHaveBeenCalled();
  });
  it('uses only the scoped tool and no previous response or personal memory input', async () => {
    const { processor, ai, credits, deliver } = setup(); await processor.process(input);
    const request = ai.respond.mock.calls[0][0] as unknown as { channelTools: { name: string }[]; previousResponseId?: string; memoryQuestion?: string; dispatchTool: (name: string, args: unknown) => Promise<string> };
    expect(request.channelTools.map(tool => tool.name)).toEqual(['search_group_channels']);
    expect(request.previousResponseId).toBeUndefined(); expect(request.memoryQuestion).toBeUndefined();
    expect(await request.dispatchTool('get_personal_memory', {})).toContain('tool_unavailable');
    expect(credits.settle).toHaveBeenCalledWith('owner', 62, 2); expect(deliver).toHaveBeenCalled();
  });
  it('cancels an in-flight provider request after access loss and refunds', async () => {
    const { processor, ai, scope, credits, deliver } = setup();
    ai.respond.mockImplementation(async (request: { signal: AbortSignal }) => new Promise<{ text: string }>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const running = processor.process(input);
    await jest.advanceTimersByTimeAsync(1);
    scope.authorize.mockRejectedValue(new NotFoundException());
    await jest.advanceTimersByTimeAsync(1000); await running;
    expect(credits.refund).toHaveBeenCalledWith('owner', 62); expect(deliver).not.toHaveBeenCalled();
  });
  it('does not regenerate or charge an already delivered trigger', async () => {
    const { processor, db, credits } = setup(); db.message.findUnique.mockResolvedValue({ id: 'reply' } as never);
    await processor.process(input); expect(credits.reserve).not.toHaveBeenCalled();
  });
  it('shows Marv typing in the channel while generating, then clears it', async () => {
    const { processor, presence } = setup(); await processor.process(input);
    const calls = presence.emitGroupChannelTyping.mock.calls.map(([payload]) => payload);
    expect(calls[0]).toMatchObject({ groupId: 'group', channelId: 'channel', typing: true, user: { id: 'marv', username: 'marv' } });
    expect(calls[calls.length - 1]).toMatchObject({ typing: false });
  });
  it('replies to an untagged message only when Jev vouches for it, and carries that through', async () => {
    const { processor, scope, ai } = setup();
    scope.authorize.mockRejectedValueOnce(new NotFoundException());
    scope.addressing.mockResolvedValue('jev');
    await processor.process(input);
    expect(scope.authorize).toHaveBeenLastCalledWith(expect.objectContaining({ addressedBy: 'jev' }));
    expect(ai.respond).toHaveBeenCalled();
  });
  it('ignores an untagged message Jev does not vouch for, and shows no typing', async () => {
    const { processor, scope, ai, presence } = setup();
    scope.authorize.mockRejectedValueOnce(new NotFoundException());
    await processor.process(input);
    expect(ai.respond).not.toHaveBeenCalled(); expect(presence.emitGroupChannelTyping).not.toHaveBeenCalled();
  });
});
