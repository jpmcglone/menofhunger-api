import { BadRequestException } from '@nestjs/common';
import { UsersLocationService } from './users-location.service';

describe('UsersLocationService', () => {
  let service: UsersLocationService;

  beforeEach(() => {
    service = new UsersLocationService();
  });

  describe('normalizeUsLocation', () => {
    it('resolves a valid ZIP to city/county/state/display', () => {
      // 90210 → Beverly Hills, Los Angeles, CA
      const result = service.normalizeUsLocation('90210');
      expect(result.zip).toBe('90210');
      expect(result.state).toBe('CA');
      expect(result.city).toBeTruthy();
      expect(result.display).toBe('California');
      expect(result.country).toBe('US');
      expect(result.input).toBe('90210');
    });

    it('strips surrounding whitespace and resolves', () => {
      const result = service.normalizeUsLocation('  90210  ');
      expect(result.zip).toBe('90210');
      expect(result.state).toBe('CA');
    });

    it('throws for non-numeric input', () => {
      expect(() => service.normalizeUsLocation('Roanoke, VA')).toThrow(BadRequestException);
    });

    it('throws for a ZIP shorter than 5 digits', () => {
      expect(() => service.normalizeUsLocation('1234')).toThrow(BadRequestException);
    });

    it('throws for a ZIP longer than 5 digits', () => {
      expect(() => service.normalizeUsLocation('123456')).toThrow(BadRequestException);
    });

    it('throws for an empty string', () => {
      expect(() => service.normalizeUsLocation('')).toThrow(BadRequestException);
    });

    it('throws for an unknown ZIP', () => {
      // 00000 is not a valid US ZIP
      expect(() => service.normalizeUsLocation('00000')).toThrow(BadRequestException);
    });

    it('returns the full state name as display', () => {
      const result = service.normalizeUsLocation('10001'); // New York, NY
      expect(result.display).toBe('New York');
      expect(result.state).toBe('NY');
    });

    it('returns display as state abbreviation when abbreviation is unknown (territories)', () => {
      // Guam ZIPs exist; display should still be a non-empty string
      const result = service.normalizeUsLocation('96910');
      expect(result.display).toBeTruthy();
    });
  });
});
