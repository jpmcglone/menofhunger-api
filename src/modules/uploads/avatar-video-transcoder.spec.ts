import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AvatarVideoTranscoder } from './avatar-video-transcoder';

describe('native avatar video processing', () => {
  it('crops a real landscape video, trims, strips audio, and produces a bounded MP4 and poster', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avatar-test-'));
    try {
      const input = join(directory, 'input.mp4');
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x320:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-c:v', 'libx264', '-c:a', 'aac', input], { timeout: 30_000 });
      const transcoder = new AvatarVideoTranscoder();
      const output = await transcoder.transcode(input, directory, { startSeconds: 1, durationSeconds: 5, crop: { x: 0.25, y: 0, width: 0.5, height: 1 } });
      expect(output.durationMs).toBeLessThanOrEqual(5000);
      expect(output.durationMs).toBeGreaterThan(4900);
      expect(output.video.length).toBeLessThanOrEqual(512 * 1024);
      expect(output.poster.length).toBeGreaterThan(100);
      const probe = await transcoder.probe(join(directory, 'avatar.mp4'));
      expect(probe.streams.map(s => s.codec_type)).toEqual(['video']);
      expect(probe.streams[0]).toMatchObject({ codec_name: 'h264', width: 320, height: 320 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60_000);
  it.each(['rotated', 'hdr'])('normalizes %s inputs to the canonical square format', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'avatar-orientation-'));
    try {
      const source = join(directory, 'source.mp4');
      const input = join(directory, 'input.mp4');
      const color = kind === 'hdr' ? ['-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc'] : [];
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x320:rate=24',
        '-t', '1', '-c:v', 'libx264', ...color, source], { timeout: 30_000 });
      // Older FFmpeg builds use stream metadata; newer builds require display_rotation.
      const useDisplayRotation = kind === 'rotated' && execFileSync('ffmpeg', ['-hide_banner', '-h', 'full'],
        { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }).includes('-display_rotation');
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error',
        ...(useDisplayRotation ? ['-display_rotation', '90'] : []), '-i', source, '-c', 'copy',
        ...(kind === 'rotated' && !useDisplayRotation ? ['-metadata:s:v:0', 'rotate=90'] : []), input], { timeout: 15_000 });
      const transcoder = new AvatarVideoTranscoder();
      const inputProbe = await transcoder.probe(input);
      if (kind === 'rotated') expect(inputProbe.streams[0]?.side_data_list?.[0]?.rotation).toBe(90);
      if (kind === 'hdr') expect(inputProbe.streams[0]?.color_transfer).toBe('smpte2084');
      const crop = kind === 'rotated' ? { x: 0, y: 0.25, width: 1, height: 0.5 } : { x: 0.25, y: 0, width: 0.5, height: 1 };
      const output = await transcoder.transcode(input, directory, { startSeconds: 0, durationSeconds: 1, crop });
      expect(output.durationMs).toBe(1000);
      expect(output.video.length).toBeLessThanOrEqual(512 * 1024);
      const final = await transcoder.probe(join(directory, 'avatar.mp4'));
      expect(final.streams[0]).toMatchObject({ width: 320, height: 320, codec_name: 'h264' });
      if (kind === 'hdr') expect(final.streams[0]?.color_transfer).toBe('bt709');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

});
