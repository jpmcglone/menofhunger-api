import { WatchPartyStateService } from './watch-party-state.service';

function makeService() {
  const redis = {
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
  } as any;
  return { svc: new WatchPartyStateService(redis), redis };
}

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

describe('WatchPartyStateService', () => {
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── getState ──────────────────────────────────────────────────────────────

  describe('getState', () => {
    it('returns null when no state has been set', () => {
      const { svc } = makeService();
      expect(svc.getState('space-1')).toBeNull();
    });

    it('returns the stored state unchanged when paused', () => {
      const { svc } = makeService();
      nowSpy.mockReturnValue(0);
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: false, currentTime: 120, playbackRate: 1 });

      nowSpy.mockReturnValue(10_000); // 10 s later — should NOT move time
      const state = svc.getState('s')!;
      expect(state.isPlaying).toBe(false);
      expect(state.currentTime).toBe(120);
      expect(state.videoUrl).toBe(VIDEO_URL);
    });

    it('drift-adjusts currentTime when playing (rate = 1)', () => {
      const { svc } = makeService();
      nowSpy.mockReturnValue(0);
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 100, playbackRate: 1 });

      nowSpy.mockReturnValue(5_000); // 5 s elapsed
      const state = svc.getState('s')!;
      expect(state.isPlaying).toBe(true);
      expect(state.currentTime).toBeCloseTo(105);
    });

    it('scales drift by playbackRate', () => {
      const { svc } = makeService();
      nowSpy.mockReturnValue(0);
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 0, playbackRate: 2 });

      nowSpy.mockReturnValue(3_000); // 3 s elapsed at 2× → 6 s of video
      expect(svc.getState('s')!.currentTime).toBeCloseTo(6);
    });

    it('returns independent state per space', () => {
      const { svc } = makeService();
      nowSpy.mockReturnValue(0);
      svc.setState('s1', { videoUrl: VIDEO_URL, isPlaying: false, currentTime: 10, playbackRate: 1 });
      svc.setState('s2', { videoUrl: VIDEO_URL, isPlaying: false, currentTime: 99, playbackRate: 1 });

      expect(svc.getState('s1')!.currentTime).toBe(10);
      expect(svc.getState('s2')!.currentTime).toBe(99);
    });
  });

  // ─── setState ──────────────────────────────────────────────────────────────

  describe('setState', () => {
    it('writes to Redis with the watch-party key and correct TTL', () => {
      const { svc, redis } = makeService();
      nowSpy.mockReturnValue(0);
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: false, currentTime: 0, playbackRate: 1 });

      expect(redis.setJson).toHaveBeenCalledWith(
        expect.stringContaining('s'),
        expect.objectContaining({ videoUrl: VIDEO_URL, isPlaying: false }),
        expect.objectContaining({ ttlSeconds: expect.any(Number) }),
      );
    });

    it('overwrites previous state for the same space', () => {
      const { svc } = makeService();
      nowSpy.mockReturnValue(0);
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: false, currentTime: 0, playbackRate: 1 });
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 50, playbackRate: 1 });

      expect(svc.getState('s')!.isPlaying).toBe(true);
      expect(svc.getState('s')!.currentTime).toBeCloseTo(50);
    });
  });

  // ─── getStateAsync ─────────────────────────────────────────────────────────

  describe('getStateAsync', () => {
    it('returns null when neither memory nor Redis has state', async () => {
      const { svc } = makeService();
      expect(await svc.getStateAsync('s')).toBeNull();
    });

    it('returns in-memory state without hitting Redis', async () => {
      const { svc, redis } = makeService();
      nowSpy.mockReturnValue(0);
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: false, currentTime: 0, playbackRate: 1 });

      const state = await svc.getStateAsync('s');
      expect(state).not.toBeNull();
      expect(redis.getJson).not.toHaveBeenCalled();
    });

    it('falls back to Redis when memory is empty, returns drift-adjusted state', async () => {
      const { svc, redis } = makeService();
      nowSpy.mockReturnValue(0);
      const stored = { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 100, playbackRate: 1, updatedAt: 0 };
      redis.getJson.mockResolvedValue(stored);

      nowSpy.mockReturnValue(4_000); // 4 s elapsed
      const state = await svc.getStateAsync('s');
      expect(state!.currentTime).toBeCloseTo(104);
    });

    it('warms the in-memory cache from Redis so subsequent sync getState works', async () => {
      const { svc, redis } = makeService();
      nowSpy.mockReturnValue(0);
      const stored = { videoUrl: VIDEO_URL, isPlaying: false, currentTime: 77, playbackRate: 1, updatedAt: 0 };
      redis.getJson.mockResolvedValue(stored);

      await svc.getStateAsync('s'); // warm cache
      expect(svc.getState('s')).not.toBeNull();
      expect(svc.getState('s')!.currentTime).toBe(77);
    });

    it('returns null (and does not throw) when Redis throws', async () => {
      const { svc, redis } = makeService();
      redis.getJson.mockRejectedValue(new Error('redis down'));
      await expect(svc.getStateAsync('s')).resolves.toBeNull();
    });
  });

  // ─── pauseAtCurrentPosition ────────────────────────────────────────────────

  describe('pauseAtCurrentPosition', () => {
    it('returns null when no state exists', () => {
      const { svc } = makeService();
      expect(svc.pauseAtCurrentPosition('s')).toBeNull();
    });

    it('keeps currentTime unchanged when already paused', () => {
      const { svc } = makeService();
      nowSpy.mockReturnValue(0);
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: false, currentTime: 45, playbackRate: 1 });

      nowSpy.mockReturnValue(5_000);
      const paused = svc.pauseAtCurrentPosition('s')!;
      expect(paused.isPlaying).toBe(false);
      expect(paused.currentTime).toBe(45);
    });

    it('freezes the drift-adjusted position when playing', () => {
      const { svc } = makeService();
      nowSpy.mockReturnValue(0);
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 10, playbackRate: 1 });

      nowSpy.mockReturnValue(5_000); // 5 s elapsed at 1×
      const paused = svc.pauseAtCurrentPosition('s')!;
      expect(paused.isPlaying).toBe(false);
      expect(paused.currentTime).toBeCloseTo(15);
    });

    it('applies playbackRate when advancing time on pause', () => {
      const { svc } = makeService();
      nowSpy.mockReturnValue(0);
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 0, playbackRate: 1.5 });

      nowSpy.mockReturnValue(4_000); // 4 s elapsed at 1.5× → 6 s of video
      const paused = svc.pauseAtCurrentPosition('s')!;
      expect(paused.currentTime).toBeCloseTo(6);
    });

    it('persists the paused state to Redis', () => {
      const { svc, redis } = makeService();
      nowSpy.mockReturnValue(0);
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 0, playbackRate: 1 });
      redis.setJson.mockClear();

      svc.pauseAtCurrentPosition('s');
      expect(redis.setJson).toHaveBeenCalledWith(
        expect.stringContaining('s'),
        expect.objectContaining({ isPlaying: false }),
        expect.any(Object),
      );
    });

    it('subsequent getState returns the paused position (not still playing)', () => {
      const { svc } = makeService();
      nowSpy.mockReturnValue(0);
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 0, playbackRate: 1 });
      nowSpy.mockReturnValue(3_000);
      svc.pauseAtCurrentPosition('s');

      // 2 more seconds pass — paused video should NOT advance
      nowSpy.mockReturnValue(5_000);
      expect(svc.getState('s')!.currentTime).toBeCloseTo(3);
    });
  });

  // ─── clearState ────────────────────────────────────────────────────────────

  describe('clearState', () => {
    it('removes state from memory', () => {
      const { svc } = makeService();
      svc.setState('s', { videoUrl: VIDEO_URL, isPlaying: false, currentTime: 0, playbackRate: 1 });
      svc.clearState('s');
      expect(svc.getState('s')).toBeNull();
    });

    it('calls Redis del with the correct key', () => {
      const { svc, redis } = makeService();
      svc.clearState('space-abc');
      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('space-abc'));
    });

    it('is safe to call when no state exists', () => {
      const { svc } = makeService();
      expect(() => svc.clearState('nonexistent')).not.toThrow();
    });
  });
});
