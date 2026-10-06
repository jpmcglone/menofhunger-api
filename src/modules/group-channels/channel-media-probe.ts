import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

type Probe = { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; side_data_list?: { rotation?: number }[] }[] };
const run = promisify(execFile);

export function validateChannelProbe(probe: Probe, kind: 'audio' | 'video', maximumDuration: number) {
  const durationSeconds = Number(probe.format?.duration);
  const stream = probe.streams?.find(item => item.codec_type === kind);
  if (!stream || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > maximumDuration) {
    throw new BadRequestException(`Choose valid ${kind} lasting ${maximumDuration} seconds or less.`);
  }
  if (kind === 'audio' && probe.streams?.some(item => item.codec_type === 'video')) throw new BadRequestException('Choose an audio file without video.');
  const rotated = Math.abs(stream.side_data_list?.find(item => item.rotation != null)?.rotation ?? 0) % 180 === 90;
  const width = kind === 'video' ? (rotated ? stream.height : stream.width) ?? 0 : null;
  const height = kind === 'video' ? (rotated ? stream.width : stream.height) ?? 0 : null;
  if (kind === 'video' && (!width || !height || width > 8192 || height > 8192)) throw new BadRequestException('Unsupported video dimensions.');
  return { durationSeconds, width, height };
}

/** Probe immutable uploaded bytes locally. Network/playlist protocols are never enabled. */
export async function probeChannelMedia(body: AsyncIterable<Uint8Array>, kind: 'audio' | 'video', maximumBytes: number, maximumDuration: number) {
  const directory = await mkdtemp(join(tmpdir(), 'moh-channel-media-'));
  try {
    let bytes = 0;
    const bounded = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      done(bytes > maximumBytes ? new BadRequestException('This file is too large.') : null, chunk);
    } });
    const path = join(directory, 'upload');
    await pipeline(Readable.from(body), bounded, createWriteStream(path, { mode: 0o600 }), { signal: AbortSignal.timeout(120_000) });
    const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,wav,aac', '-show_streams', '-show_format', '-of', 'json', path], { timeout: 15_000, maxBuffer: 512 * 1024 });
    return validateChannelProbe(JSON.parse(stdout), kind, maximumDuration);
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new ServiceUnavailableException('Media processing is temporarily unavailable.');
    throw new BadRequestException('This media could not be read. Choose another file.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
