import { Injectable, Logger } from '@nestjs/common';
import type { RtcIceServerDto } from '../../common/dto/call.dto';
import { AppConfigService } from '../app/app-config.service';

const MINT_TTL_SECONDS = 86_400;
const CACHE_MS = 10 * 60 * 1000;
const MINT_TIMEOUT_MS = 4_000;
const CF_TURN_CREDENTIALS_URL = (keyId: string) =>
  `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`;

/** Browsers stall on TURN/STUN port 53; drop those URLs when trickle ICE is in play. */
export function withoutBrowserBlockedIceUrls(urls: string[]): string[] {
  return urls.filter((url) => !/:53(?:\?|$)/.test(url));
}

export function parseCloudflareIceServers(body: unknown): RtcIceServerDto[] | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as { iceServers?: unknown }).iceServers;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const servers: RtcIceServerDto[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const urlsRaw = (entry as { urls?: unknown }).urls;
    const urls = withoutBrowserBlockedIceUrls(
      (Array.isArray(urlsRaw) ? urlsRaw : typeof urlsRaw === 'string' ? [urlsRaw] : [])
        .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
        .map((u) => u.trim()),
    );
    if (urls.length === 0) continue;
    const username = (entry as { username?: unknown }).username;
    const credential = (entry as { credential?: unknown }).credential;
    const server: RtcIceServerDto = { urls };
    if (typeof username === 'string' && username) server.username = username;
    if (typeof credential === 'string' && credential) server.credential = credential;
    servers.push(server);
  }
  return servers.length > 0 ? servers : null;
}

/**
 * ICE servers for call start/join. Prefers Cloudflare Realtime TURN (short-lived
 * credentials). Falls back to static STUN / `RTC_TURN_*` if minting is unset or fails.
 */
@Injectable()
export class RtcIceServersService {
  private readonly logger = new Logger(RtcIceServersService.name);
  private cached: { servers: RtcIceServerDto[]; expiresAt: number } | null = null;
  private inflight: Promise<RtcIceServerDto[]> | null = null;

  constructor(private readonly appConfig: AppConfigService) {}

  async resolve(): Promise<RtcIceServerDto[]> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.servers;
    if (this.inflight) return this.inflight;
    this.inflight = this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<RtcIceServerDto[]> {
    const minted = await this.mintCloudflare();
    if (minted) {
      this.cached = { servers: minted, expiresAt: Date.now() + CACHE_MS };
      return minted;
    }
    if (this.cached) return this.cached.servers;
    return this.appConfig.rtcIceServers();
  }

  private async mintCloudflare(): Promise<RtcIceServerDto[] | null> {
    const cfg = this.appConfig.cloudflareTurn();
    if (!cfg) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
    try {
      const res = await fetch(CF_TURN_CREDENTIALS_URL(cfg.keyId), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: MINT_TTL_SECONDS }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`[calls] Cloudflare TURN mint failed status=${res.status}`);
        return null;
      }
      const parsed = parseCloudflareIceServers(await res.json());
      if (!parsed) {
        this.logger.warn('[calls] Cloudflare TURN mint returned no usable iceServers');
        return null;
      }
      return parsed;
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'error';
      this.logger.warn(`[calls] Cloudflare TURN mint failed reason=${reason}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
