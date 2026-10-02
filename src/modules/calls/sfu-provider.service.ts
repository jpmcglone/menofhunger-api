import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import type { RtcSessionDescriptionDto } from '../../common/dto/call.dto';

export type SfuProviderResult = {
  sessionId?: string;
  sessionDescription?: RtcSessionDescriptionDto;
  requiresImmediateRenegotiation?: boolean;
  errorCode?: string;
  tracks?: Array<{
    mid?: string;
    trackName?: string;
    status?: string;
    errorCode?: string;
  }>;
};

/** Provider credentials and untrusted provider errors never leave this boundary. */
@Injectable()
export class SfuProviderService {
  constructor(private readonly config: AppConfigService) {}

  enabled(): boolean {
    return this.config.callsSfuEnabled() && this.config.cloudflareSfu() !== null;
  }

  async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<SfuProviderResult> {
    const cfg = this.config.cloudflareSfu();
    if (!cfg) throw new Error('SFU unavailable');
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(cfg.appId)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.secret}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(6_000),
    });
    if (response.status === 404 && method === 'GET') return { tracks: [] };
    if (!response.ok) throw new Error('SFU request failed');
    const result = (await response.json()) as SfuProviderResult;
    if (
      result.errorCode ||
      result.tracks?.some((track) => track.errorCode && !(path.endsWith('/tracks/close') && track.errorCode === 'close_track_error'))
    )
      throw new Error('SFU negotiation failed');
    return result;
  }

  async closeAll(sessionId: string): Promise<void> {
    const result = await this.request('GET', `/sessions/${encodeURIComponent(sessionId)}`);
    const mids = [...new Set((result.tracks ?? []).flatMap((track) => (track.mid && track.status !== 'inactive' ? [track.mid] : [])))];
    await this.close(sessionId, mids);
  }

  async close(sessionId: string, mids: string[]): Promise<void> {
    if (!mids.length) return;
    const result = await this.request('PUT', `/sessions/${encodeURIComponent(sessionId)}/tracks/close`, {
      tracks: mids.map((mid) => ({ mid })),
      force: true,
    });
    if (result.tracks?.some((track) => track.errorCode)) {
      const current = await this.request('GET', `/sessions/${encodeURIComponent(sessionId)}`);
      if (current.tracks?.some((track) => track.mid && mids.includes(track.mid) && track.status !== 'inactive')) {
        throw new Error('SFU cleanup incomplete');
      }
    }
  }
}
