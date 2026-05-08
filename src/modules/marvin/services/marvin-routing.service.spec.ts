import { MarvinRoutingService } from './marvin-routing.service';

describe('MarvinRoutingService', () => {
  const svc = new MarvinRoutingService();

  describe('Smart never gets downgraded', () => {
    it('keeps smart even on trivial questions', () => {
      const r = svc.resolve({
        requested: 'smart',
        source: 'public_thread',
        estimatedInputTokens: 5,
        text: 'hi',
      });
      expect(r.mode).toBe('smart');
      expect(r.reason).toBe('user_selected_smart');
    });
  });

  describe('Crisis detection forces smart + sets the flag', () => {
    const phrases = [
      'i want to kill myself',
      'going to end my life tonight',
      'i want to die',
      'i should self-harm',
      "no reason to live anymore",
    ];
    for (const text of phrases) {
      it(`upgrades fast → smart and flags crisis for "${text}"`, () => {
        const r = svc.resolve({
          requested: 'fast',
          source: 'private_session',
          estimatedInputTokens: 10,
          text,
        });
        expect(r.mode).toBe('smart');
        expect(r.crisisDetected).toBe(true);
        expect(r.reason).toBe('crisis_keywords');
      });
    }
  });

  describe('Sensitive-topic upgrades fast/regular → smart', () => {
    const cases: Array<{ text: string; reason: string }> = [
      { text: 'is divorce ever permitted?', reason: 'sensitive_topic' },
      { text: 'what does Calvinism say about predestination?', reason: 'sensitive_topic' },
      { text: 'i keep struggling with porn addiction and shame', reason: 'sensitive_topic' },
      { text: 'how do i fact-check this claim about scripture', reason: 'sensitive_topic' },
    ];
    for (const c of cases) {
      it(`upgrades for "${c.text}"`, () => {
        const r = svc.resolve({
          requested: 'fast',
          source: 'public_thread',
          estimatedInputTokens: 100,
          text: c.text,
        });
        expect(r.mode).toBe('smart');
        expect(r.reason).toBe(c.reason);
      });
    }
  });

  describe('Long context auto-upgrades to smart', () => {
    it('promotes fast → smart at the SMART_TOKEN_THRESHOLD', () => {
      const r = svc.resolve({
        requested: 'fast',
        source: 'public_thread',
        estimatedInputTokens: MarvinRoutingService.SMART_TOKEN_THRESHOLD,
        text: 'a non-sensitive question',
      });
      expect(r.mode).toBe('smart');
      expect(r.reason).toBe('long_context');
    });
  });

  describe('Multi-user threads upgrade to smart', () => {
    it('flags multi_user_thread when distinctAuthors >= 4', () => {
      const r = svc.resolve({
        requested: 'fast',
        source: 'public_thread',
        estimatedInputTokens: 100,
        text: 'a non-sensitive question',
        distinctAuthors: 5,
      });
      expect(r.mode).toBe('smart');
      expect(r.reason).toBe('multi_user_thread');
    });
  });

  describe('Soft fast → regular upgrade for medium context', () => {
    it('promotes fast → regular at REGULAR_TOKEN_THRESHOLD', () => {
      const r = svc.resolve({
        requested: 'fast',
        source: 'public_thread',
        estimatedInputTokens: MarvinRoutingService.REGULAR_TOKEN_THRESHOLD,
        text: 'a non-sensitive question',
      });
      expect(r.mode).toBe('regular');
      expect(r.reason).toBe('medium_context');
    });

    it('keeps fast for short non-sensitive questions', () => {
      const r = svc.resolve({
        requested: 'fast',
        source: 'public_thread',
        estimatedInputTokens: 50,
        text: 'when does the next radio show start?',
      });
      expect(r.mode).toBe('fast');
      expect(r.reason).toBe('user_selected');
    });
  });

  describe('Implicit web-search signal upgrades fast → regular (webSearchEnabled=true)', () => {
    const timeSensitivePhrases = [
      "what's in the news today?",
      'what is happening right now?',
      "what's the latest from the election?",
      'can you look it up?',
      'what happened yesterday?',
      'what are the current standings?',
    ];
    for (const text of timeSensitivePhrases) {
      it(`upgrades fast → regular for "${text}" when webSearchEnabled`, () => {
        const r = svc.resolve({
          requested: 'fast',
          source: 'private_session',
          estimatedInputTokens: 20,
          text,
          webSearchEnabled: true,
        });
        expect(r.mode).toBe('regular');
        expect(r.reason).toBe('web_search_signal');
        expect(r.webSearchDemanded).toBe(false);
      });

      it(`keeps fast for "${text}" when webSearchEnabled=false`, () => {
        const r = svc.resolve({
          requested: 'fast',
          source: 'private_session',
          estimatedInputTokens: 20,
          text,
          webSearchEnabled: false,
        });
        expect(r.mode).toBe('fast');
        expect(r.webSearchDemanded).toBe(false);
      });
    }

    it('does not upgrade regular → smart on an implicit web search signal alone', () => {
      const r = svc.resolve({
        requested: 'regular',
        source: 'private_session',
        estimatedInputTokens: 20,
        text: "what's in the news today?",
        webSearchEnabled: true,
      });
      expect(r.mode).toBe('regular');
    });
  });

  describe('Explicit web-search demand upgrades fast → regular and sets webSearchDemanded', () => {
    const explicitPhrases = [
      'search the web for this',
      'search the web for latest news',
      'can you search for me',
      'do a web search',
      'google this for me',
    ];
    for (const text of explicitPhrases) {
      it(`sets webSearchDemanded=true and upgrades fast → regular for "${text}"`, () => {
        const r = svc.resolve({
          requested: 'fast',
          source: 'private_session',
          estimatedInputTokens: 20,
          text,
          webSearchEnabled: true,
        });
        expect(r.mode).toBe('regular');
        expect(r.reason).toBe('explicit_search_demand');
        expect(r.webSearchDemanded).toBe(true);
      });

      it(`keeps fast and webSearchDemanded=false for "${text}" when webSearchEnabled=false`, () => {
        const r = svc.resolve({
          requested: 'fast',
          source: 'private_session',
          estimatedInputTokens: 20,
          text,
          webSearchEnabled: false,
        });
        expect(r.mode).toBe('fast');
        expect(r.webSearchDemanded).toBe(false);
      });
    }

    it('keeps regular at regular with webSearchDemanded=true for explicit demand', () => {
      const r = svc.resolve({
        requested: 'regular',
        source: 'private_session',
        estimatedInputTokens: 20,
        text: 'search the web for me',
        webSearchEnabled: true,
      });
      expect(r.mode).toBe('regular');
      expect(r.webSearchDemanded).toBe(true);
    });
  });

  describe('Auto mode routes from fast upward', () => {
    it('routes to fast for a trivial query', () => {
      const r = svc.resolve({
        requested: 'auto',
        source: 'private_session',
        estimatedInputTokens: 10,
        text: 'hey',
      });
      expect(r.mode).toBe('fast');
      expect(r.reason).toBe('auto_routed');
    });

    it('upgrades to regular on a web-search signal', () => {
      const r = svc.resolve({
        requested: 'auto',
        source: 'private_session',
        estimatedInputTokens: 10,
        text: "what's in the news today?",
        webSearchEnabled: true,
      });
      expect(r.mode).toBe('regular');
    });

    it('upgrades to smart on a crisis signal', () => {
      const r = svc.resolve({
        requested: 'auto',
        source: 'private_session',
        estimatedInputTokens: 10,
        text: 'i want to die',
      });
      expect(r.mode).toBe('smart');
      expect(r.crisisDetected).toBe(true);
    });
  });

  describe('estimateTokens', () => {
    it('returns 0 for empty', () => {
      expect(svc.estimateTokens('')).toBe(0);
    });

    it('approximates ~4 chars per token', () => {
      expect(svc.estimateTokens('abcd')).toBe(1);
      expect(svc.estimateTokens('a'.repeat(40))).toBe(10);
    });
  });
});
