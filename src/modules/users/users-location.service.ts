import { BadRequestException, Injectable } from '@nestjs/common';
import * as zipcodes from 'zipcodes-nrviens';

export type NormalizedLocation = {
  input: string;
  display: string;
  zip: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  country: string;
};

export type NormalizedUsLocation = NormalizedLocation & { country: 'US' };

/** Maps two-letter state abbreviations to full state names. */
export const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'Washington DC',
  AS: 'American Samoa', GU: 'Guam', MP: 'Northern Mariana Islands',
  PR: 'Puerto Rico', VI: 'U.S. Virgin Islands',
};

@Injectable()
export class UsersLocationService {
  /**
   * Resolve a 5-digit US ZIP code to city/county/state using an offline bundled dataset.
   * No external API calls, no API keys required.
   */
  normalizeUsLocation(rawQuery: string): NormalizedUsLocation {
    const zip = rawQuery.replace(/\D/g, '');
    if (zip.length !== 5) {
      throw new BadRequestException('Enter a valid 5-digit US ZIP code.');
    }

    const result = zipcodes.lookup(zip);
    if (!result || !result.state) {
      throw new BadRequestException('ZIP code not found.');
    }

    const stateAbbr = (result.state ?? '').toUpperCase();
    const display = STATE_NAMES[stateAbbr] ?? stateAbbr;

    return {
      input: zip,
      display,
      zip,
      city: result.city ?? null,
      county: result.county ?? null,
      state: stateAbbr || null,
      country: 'US',
    };
  }

  /**
   * A US ZIP, or "City, Country" for a man who lives somewhere else.
   * The United States stays on the ZIP path.
   */
  normalizeLocation(rawQuery: string): NormalizedLocation {
    const q = rawQuery.trim();
    const compact = q.replace(/\s/g, '');
    if (/^\d{5}$/.test(compact)) return this.normalizeUsLocation(compact);

    const comma = q.indexOf(',');
    if (comma > 0) {
      const city = q.slice(0, comma).trim().replace(/\s+/g, ' ');
      const country = q.slice(comma + 1).trim().replace(/\s+/g, ' ');
      if (city.length >= 2 && city.length <= 40 && country.length >= 2 && country.length <= 40) {
        const countryKey = country.toLowerCase();
        const usCountry = new Set(['us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america', 'america']);
        const stateName = Object.values(STATE_NAMES).some((name) => name.toLowerCase() === countryKey);
        if (usCountry.has(countryKey) || STATE_NAMES[country.toUpperCase()] || stateName) {
          throw new BadRequestException('Use your ZIP code for a place in the United States.');
        }
        return {
          input: `${city}, ${country}`,
          display: `${city}, ${country}`,
          zip: null,
          city,
          county: null,
          state: null,
          country,
        };
      }
    }

    throw new BadRequestException('Enter a US ZIP code, or City, Country if you live somewhere else.');
  }
}
