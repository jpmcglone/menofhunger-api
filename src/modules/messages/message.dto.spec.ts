import { toMessageDto } from './message.dto';

const message = (extra: Record<string, unknown> = {}): any => ({
  id: 'original', createdAt: new Date(), body: 'private text', conversationId: 'conversation',
  sender: { id: 'sender', username: 'sender' }, kind: 'text', deletedForAll: false,
  media: [{ id: 'media', source: 'upload', kind: 'image', r2Key: 'private-image' }],
  ...extra,
});
const dto = (m: any) => toMessageDto({ message: m, publicBaseUrl: 'https://assets.example.com' });

describe('deleted message redaction', () => {
  it('removes content and media from a message deleted for everyone', () => {
    const result = dto(message({ deletedForAll: true, replyTo: message() }));
    expect(result.deletedForAll).toBe(true);
    expect(result.body).toBe('');
    expect(result.media).toEqual([]);
    expect(result.replyTo).toBeNull();
    expect(result.call).toBeNull();
    expect(result.reactions).toEqual([]);
  });
  it('redacts a deleted reply target while preserving the reply itself', () => {
    const result = dto(message({ id: 'reply', body: 'my reply', replyTo: message({ deletedForAll: true }) }));
    expect(result.body).toBe('my reply');
    expect(result.replyTo).toEqual({ id: 'original', senderUsername: 'sender', bodyPreview: 'Message deleted', mediaThumbnailUrl: null });
  });
  it('preserves content for ordinary messages and reply targets', () => {
    const result = dto(message({ replyTo: message() }));
    expect(result.body).toBe('private text');
    expect(result.media[0].url).toContain('private-image');
    expect(result.replyTo?.bodyPreview).toBe('private text');
    expect(result.replyTo?.mediaThumbnailUrl).toContain('private-image');
  });
});
