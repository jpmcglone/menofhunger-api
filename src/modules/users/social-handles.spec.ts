import { BadRequestException } from '@nestjs/common';
import { normalizeSocialHandle } from './social-handles';

describe('normalizeSocialHandle – X', () => {
  const n = (raw: string) => normalizeSocialHandle('x', raw);

  it('returns a bare handle unchanged', () => {
    expect(n('TheMcGloneCode')).toBe('TheMcGloneCode');
  });

  it('strips a leading @', () => {
    expect(n('@TheMcGloneCode')).toBe('TheMcGloneCode');
  });

  it('extracts handle from https://x.com/handle', () => {
    expect(n('https://x.com/TheMcGloneCode')).toBe('TheMcGloneCode');
  });

  it('extracts handle from https://twitter.com/handle (alias)', () => {
    expect(n('https://twitter.com/TheMcGloneCode')).toBe('TheMcGloneCode');
  });

  it('extracts handle from bare x.com/handle', () => {
    expect(n('x.com/TheMcGloneCode')).toBe('TheMcGloneCode');
  });

  it('extracts handle from @-prefixed URL', () => {
    expect(n('@TheMcGloneCode')).toBe('TheMcGloneCode');
  });

  it('allows underscores', () => {
    expect(n('hello_world')).toBe('hello_world');
  });

  it('rejects handles with spaces', () => {
    expect(() => n('hello world')).toThrow(BadRequestException);
  });

  it('rejects handles longer than 15 characters', () => {
    expect(() => n('a'.repeat(16))).toThrow(BadRequestException);
  });

  it('rejects handles with invalid chars like @', () => {
    expect(() => n('bad@handle')).toThrow(BadRequestException);
  });

  it('rejects a URL from a different network', () => {
    expect(() => n('https://pickax.com/someone')).toThrow(BadRequestException);
  });
});

describe('normalizeSocialHandle – Pickax', () => {
  const n = (raw: string) => normalizeSocialHandle('pickax', raw);

  it('returns a bare handle unchanged', () => {
    expect(n('erin_pinson823')).toBe('erin_pinson823');
  });

  it('strips a leading @', () => {
    expect(n('@erin_pinson823')).toBe('erin_pinson823');
  });

  it('extracts handle from https://pickax.com/handle', () => {
    expect(n('https://pickax.com/erin_pinson823')).toBe('erin_pinson823');
  });

  it('extracts handle from bare pickax.com/handle', () => {
    expect(n('pickax.com/erin_pinson823')).toBe('erin_pinson823');
  });

  it('allows dots and hyphens', () => {
    expect(n('john.doe-123')).toBe('john.doe-123');
  });

  it('rejects handles longer than 30 characters', () => {
    expect(() => n('a'.repeat(31))).toThrow(BadRequestException);
  });

  it('rejects a URL from a different network', () => {
    expect(() => n('https://x.com/someone')).toThrow(BadRequestException);
  });
});
