declare module 'zipcodes-nrviens' {
  interface ZipInfo {
    zip: string;
    latitude: number;
    longitude: number;
    city: string;
    state: string;
    country: string;
    fips?: number | string;
    county?: string;
  }

  function lookup(zip: string | number): ZipInfo | undefined;
  function lookupByName(city: string, state: string): ZipInfo[];
  function radius(zip: string | number, miles: number): string[];
}
