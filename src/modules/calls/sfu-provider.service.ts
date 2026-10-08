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

/** Only controlled metadata may be logged; never provider response bodies or SDP. */
export class SfuProviderError extends Error {
  constructor(readonly reason: 'http' | 'network' | 'negotiation', readonly status?: number) {
    super(`SFU request failed: ${reason}${status === undefined ? '' : ` (${status})`}`);
  }
}

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
    }).catch(() => { throw new SfuProviderError('network'); });
    // Cloudflare answers 404 or 410 once a session has expired or all its tracks closed (an empty
    // receiver session expires quickly). For cleanup that is success: there is nothing left to close.
    const sessionGone = response.status === 404 || response.status === 410;
    if (sessionGone && (method === 'GET' || path.endsWith('/tracks/close'))) return { tracks: [] };
    if (!response.ok) throw new SfuProviderError('http', response.status);
    const result = (await response.json()) as SfuProviderResult;
    if (
      result.errorCode ||
      result.tracks?.some((track) => track.errorCode && !(path.endsWith('/tracks/close') && track.errorCode === 'close_track_error'))
    )
      throw new SfuProviderError('negotiation', response.status);
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
