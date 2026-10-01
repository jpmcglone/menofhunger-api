import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { AppConfigService } from '../app/app-config.service';
import type { PickaxTokenPair } from './pickax-api.client';

export const pickaxOAuthIdentity = z.object({ data: z.object({ id: z.string().min(1).max(200), username: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/) }) });
export const pickaxOAuthTokens = z.object({ access_token: z.string().min(1), token_type: z.literal('Bearer'), expires_in: z.number().int().positive(), refresh_token: z.string().min(1) });
/** Proposed Pickax contract, deliberately unavailable until the partner fixture suite is approved. */
@Injectable()
export class PickaxOAuthClient {
  constructor(private readonly cfg: AppConfigService) {}
  config() {
    const c = this.cfg.partner();
    if (!c.pickaxOAuth || !c.pickaxOAuthIssuer || !c.pickaxOAuthClientId || !c.pickaxOAuthClientSecret) throw new ServiceUnavailableException('Pickax OAuth is not available yet.');
    const issuer = new URL(c.pickaxOAuthIssuer);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) throw new ServiceUnavailableException('Pickax OAuth is not configured.');
    return { partnerClientId: c.pickaxPartnerClientId, issuer: issuer.href.replace(/\/$/, ''), clientId: c.pickaxOAuthClientId, clientSecret: c.pickaxOAuthClientSecret,
      redirectUri: `${this.cfg.frontendBaseUrl()}/connect/pickax` };
  }
  available() { try { this.config(); return true; } catch { return false; } }
  async tokens(body: Record<string, string>): Promise<PickaxTokenPair> {
    const c = this.config();
    const response = await fetch(`${c.issuer}/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString('base64')}` },
      body: new URLSearchParams(body) });
    if (!response.ok) throw new ServiceUnavailableException('Pickax authorization could not be completed. Try connecting again.');
    const token = pickaxOAuthTokens.parse(await response.json());
    return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresInSeconds: token.expires_in, responseKeys: [] };
  }
  async revoke(token: string) {
    const c = this.config();
    const response = await fetch(`${c.issuer}/revoke`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString('base64')}` },
      body: new URLSearchParams({ token, token_type_hint: 'refresh_token' }) });
    if (!response.ok) throw new ServiceUnavailableException('Pickax did not confirm token revocation.');
  }
  async me(token: string) {
    const response = await fetch(`${this.config().issuer}/me`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new ServiceUnavailableException('Pickax did not confirm this account.');
    return pickaxOAuthIdentity.parse(await response.json()).data;
  }
}
