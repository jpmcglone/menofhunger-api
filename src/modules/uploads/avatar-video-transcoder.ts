import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AVATAR_VIDEO_MAX_OUTPUT_BYTES, avatarCropPixels, type AvatarVideoSelection } from './avatar-video-policy';

const run = promisify(execFile);
type ProbeStream = {
  codec_type: string; codec_name: string; width: number; height: number;
  duration?: string; color_transfer?: string; side_data_list?: { rotation?: number }[];
};

@Injectable()
export class AvatarVideoTranscoder {
  async probe(path: string): Promise<{ streams: ProbeStream[]; format: { duration: string } }> {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm',
      '-show_streams', '-show_format', '-of', 'json', path], { timeout: 15_000, maxBuffer: 512 * 1024 });
    return JSON.parse(stdout);
  }

  async transcode(input: string, directory: string, selection: AvatarVideoSelection) {
    const probe = await this.probe(input);
    const stream = probe.streams.find(s => s.codec_type === 'video');
    const duration = Number(probe.format.duration);
    if (!stream || !Number.isFinite(duration) || duration > 600 || duration < selection.startSeconds + selection.durationSeconds - 0.05) {
      throw new Error('Choose a video under 10 minutes and a segment within its duration.');
    }
    const rotated = Math.abs(stream.side_data_list?.find(s => s.rotation != null)?.rotation ?? 0) % 180 === 90;
    const width = rotated ? stream.height : stream.width;
    const height = rotated ? stream.width : stream.height;
    if (!(width > 1 && height > 1 && width <= 8192 && height <= 8192)) throw new Error('Unsupported video dimensions.');
    const crop = avatarCropPixels(selection, width, height);
    const filters = [`crop=${crop.size}:${crop.size}:${crop.x}:${crop.y}`, 'scale=320:320', 'setsar=1', 'fps=24'];
    if (['smpte2084', 'arib-std-b67'].includes(stream.color_transfer ?? '')) {
      filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable', 'zscale=t=bt709:m=bt709:r=tv');
    }
    filters.push('format=yuv420p', 'setpts=PTS-STARTPTS');
    const videoPath = join(directory, 'avatar.mp4');
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-threads', '2', '-filter_threads', '1',
      '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-ss', String(selection.startSeconds), '-i', input,
      '-t', String(selection.durationSeconds), '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1',
      '-vf', filters.join(','), '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-profile:v', 'main',
      '-crf', '25', '-maxrate', '650k', '-bufsize', '650k', '-g', '24', '-movflags', '+faststart', videoPath],
    { timeout: 90_000, maxBuffer: 512 * 1024 });
    const output = await this.probe(videoPath);
    const video = output.streams.find(s => s.codec_type === 'video');
    const durationMs = Math.round(Number(output.format.duration) * 1000);
    if (!video || video.codec_name !== 'h264' || video.width !== 320 || video.height !== 320
      || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 5000
      || output.streams.some(s => s.codec_type === 'audio') || (await stat(videoPath)).size > AVATAR_VIDEO_MAX_OUTPUT_BYTES) {
      throw new Error('Could not create a small enough avatar. Try a different segment.');
    }
    const posterPath = join(directory, 'poster.jpg');
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', videoPath, '-frames:v', '1', '-q:v', '3', posterPath],
      { timeout: 15_000, maxBuffer: 512 * 1024 });
    return { video: await readFile(videoPath), poster: await readFile(posterPath), durationMs };
  }
}
