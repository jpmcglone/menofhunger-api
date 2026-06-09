import { BadRequestException, Injectable } from '@nestjs/common';
import * as zipcodes from 'zipcodes-nrviens';

export type NormalizedUsLocation = {
  input: string;
  display: string;
  zip: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  country: 'US';
};

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
}
