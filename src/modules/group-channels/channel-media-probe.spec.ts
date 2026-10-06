import { validateChannelProbe } from './channel-media-probe';

describe('channel media inspection', () => {
  it('uses the actual rotated video dimensions and duration', () => {
    expect(validateChannelProbe({ format: { duration: '15.25' }, streams: [{ codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }] }, 'video', 300)).toEqual({ width: 1080, height: 1920, durationSeconds: 15.25 });
  });
  it.each(['301', 'NaN', '0', '-1', 'Infinity'])('rejects invalid or excessive actual duration %s', duration => {
    expect(() => validateChannelProbe({ format: { duration }, streams: [{ codec_type: 'video', width: 640, height: 480 }] }, 'video', 300)).toThrow();
  });
  it('cannot disguise video as an audio attachment', () => {
    expect(() => validateChannelProbe({ format: { duration: '10' }, streams: [{ codec_type: 'audio' }, { codec_type: 'video' }] }, 'audio', 120)).toThrow('without video');
  });
  it('requires an actual media stream and bounded dimensions', () => {
    expect(() => validateChannelProbe({ format: { duration: '10' }, streams: [] }, 'audio', 120)).toThrow();
    expect(() => validateChannelProbe({ format: { duration: '10' }, streams: [{ codec_type: 'video', width: 9000, height: 100 }] }, 'video', 300)).toThrow('dimensions');
  });
});
