import { BadRequestException, Injectable } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import { RedisKeys } from '../redis/redis-keys';
import { CacheService } from '../redis/cache.service';
import { CacheTtl } from '../redis/cache-ttl';

export type NormalizedUsLocation = {
  input: string;
  display: string;
  zip: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  country: 'US';
};

type MapboxFeature = {
  id?: string;
  text?: string;
  place_name?: string;
  place_type?: string[];
  context?: Array<{
    id?: string;
    text?: string;
    short_code?: string;
  }>;
  properties?: {
    short_code?: string;
  };
};

function ctxByPrefix(feature: MapboxFeature | null | undefined, prefix: string) {
  const c = feature?.context ?? [];
  return c.find((x) => typeof x?.id === 'string' && x.id.startsWith(prefix)) ?? null;
}

function getStateCodeFromContext(feature: MapboxFeature | null | undefined): string | null {
  const region = ctxByPrefix(feature, 'region.');
  const sc = (region?.short_code ?? '').trim().toLowerCase();
  // Mapbox commonly returns 'us-va' etc.
  if (sc.startsWith('us-') && sc.length === 5) return sc.slice(3).toUpperCase();
  if (typeof region?.text === 'string' && region.text.trim()) return region.text.trim();
  return null;
}

function ensure5DigitZip(zip: string | null): string | null {
  const z = (zip ?? '').trim();
  if (!z) return null;
  const m = z.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

@Injectable()
export class UsersLocationService {
  constructor(
    private readonly appConfig: AppConfigService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Normalize a US-only location. Input can be ZIP or free-text (city/state).
   *
   * Uses Mapbox Geocoding API and returns structured fields suitable for
   * city/county/state grouping + display.
   */
  async normalizeUsLocation(rawQuery: string): Promise<NormalizedUsLocation> {
    const query = (rawQuery ?? '').trim();
    if (!query) throw new BadRequestException('Location is required.');

    const cacheKey = RedisKeys.geoUs(query);
    const cached = await this.cache.getJson<NormalizedUsLocation>(cacheKey);
    if (cached?.display && cached.country === 'US') return cached;

    const mapbox = this.appConfig.mapbox();
    if (!mapbox) throw new BadRequestException('Location lookup is not configured.');

    const url = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`);
    url.searchParams.set('access_token', mapbox.accessToken);
    url.searchParams.set('country', 'us');
    // Prefer ZIP/city-like results; keep a small limit for predictable behavior.
    url.searchParams.set('types', 'postcode,place,locality,district,region');
    url.searchParams.set('limit', '1');

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), mapbox.geocodeTimeoutMs);

    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new BadRequestException('Location lookup failed.');
      const json = (await res.json()) as { features?: MapboxFeature[] };
      const feature = (json?.features ?? [])[0] ?? null;
      if (!feature) throw new BadRequestException('Location not found.');

      const countryCtx = ctxByPrefix(feature, 'country.');
      const countryCode = (countryCtx?.short_code ?? countryCtx?.text ?? '').toString().trim().toLowerCase();
      if (countryCode && countryCode !== 'us' && countryCode !== 'united states') {
        throw new BadRequestException('Location must be in the United States.');
      }

      // ZIP: only populated when the top feature is a postcode-like hit.
      const isPostcode = Array.isArray(feature.place_type) && feature.place_type.includes('postcode');
      const zip = ensure5DigitZip(isPostcode ? (feature.text ?? null) : null);

      const place = ctxByPrefix(feature, 'place.');
      const locality = ctxByPrefix(feature, 'locality.');
      const district = ctxByPrefix(feature, 'district.');

      const city =
        (typeof place?.text === 'string' && place.text.trim()) ? place.text.trim()
          : (typeof locality?.text === 'string' && locality.text.trim()) ? locality.text.trim()
            : (Array.isArray(feature.place_type) && (feature.place_type.includes('place') || feature.place_type.includes('locality')) && feature.text?.trim())
              ? feature.text.trim()
              : null;

      const county = typeof district?.text === 'string' && district.text.trim() ? district.text.trim() : null;
      const state = getStateCodeFromContext(feature);

      const display =
        city && state
          ? `${city}, ${state}`
          : (typeof feature.place_name === 'string' && feature.place_name.trim())
            ? feature.place_name.trim()
            : city ?? query;

      const result: NormalizedUsLocation = {
        input: query,
        display,
        zip,
        city,
        county,
        state,
        country: 'US',
      };
      // Cache successful normalizations to reduce Mapbox traffic.
      void this.cache.setJson(cacheKey, result, { ttlSeconds: CacheTtl.geoUsSeconds }).catch(() => undefined);
      return result;
    } catch (err: unknown) {
      if (err instanceof BadRequestException) throw err;
      // Timeout / network errors should look like a validation failure to the client.
      throw new BadRequestException('Location lookup failed.');
    } finally {
      clearTimeout(t);
    }
  }
}

