import { LiveChatStore, normalizeLiveChatBody } from './live-chat-store';
import { RadioChatService } from '../../modules/radio/radio-chat.service';

describe('LiveChatStore', () => {
  afterEach(() => jest.useRealTimers());

  it('enforces the minimum gap and token bucket per user', () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const store = new LiveChatStore<string>();
    expect(store.canSend('u1')).toBe(true);
    expect(store.canSend('u1')).toBe(false); // inside 450ms gap
    expect(store.canSend('u2')).toBe(true); // separate bucket
    let sent = 1;
    for (let i = 0; i < 20; i++) {
      jest.advanceTimersByTime(500);
      if (store.canSend('u1')) sent++;
    }
    // 8-token bucket refilling one token per 900ms over 10s.
    expect(sent).toBeLessThan(21);
    expect(sent).toBeGreaterThanOrEqual(8);
    expect(store.canSend('  ')).toBe(false);
  });

  it('caps room history and clips bodies', () => {
    const store = new LiveChatStore<number>();
    for (let i = 0; i < 230; i++) store.push('room', i);
    const messages = store.messages(' room ')!;
    expect(messages).toHaveLength(220);
    expect(messages[0]).toBe(10);
    expect(store.clip('x'.repeat(300))).toHaveLength(280);
  });

  it('normalizes bodies to a single line', () => {
    expect(normalizeLiveChatBody(' a\n\tb\u0000  c ')).toBe('a b c');
  });
});

describe('RadioChatService', () => {
  it('appends, ids by station sequence, and snapshots history', () => {
    const chat = new RadioChatService();
    const sender = { id: 'u1' } as never;
    const first = chat.appendMessage({ stationId: ' s1 ', sender, body: ' hi\nthere ' })!;
    const second = chat.appendMessage({ stationId: 's1', sender, body: 'again' })!;
    expect(first.body).toBe('hi there');
    expect(first.id).toMatch(/^s1:[0-9a-z]+:1$/);
    expect(second.id).toMatch(/^s1:[0-9a-z]+:2$/);
    expect(chat.appendMessage({ stationId: 's1', sender, body: '   ' })).toBeNull();
    expect(chat.snapshot('s1').messages.map((m) => m.body)).toEqual(['hi there', 'again']);
    expect(chat.snapshot('other')).toEqual({ stationId: 'other', messages: [] });
  });
});
