import { resolvePrismaConnectionConfig } from './prisma-connection-config';

describe('Prisma connection budget', () => {
  const base = 'postgresql://app:private%40password@database:5432/moh';

  it('bounds connections and waiting when the deployment omits pool parameters', () => {
    const config = resolvePrismaConnectionConfig(base);
    expect(config.connectionLimit).toBe(5);
    expect(config.poolTimeoutSeconds).toBe(10);
    const url = new URL(config.url);
    expect(url.searchParams.get('connection_limit')).toBe('5');
    expect(url.searchParams.get('pool_timeout')).toBe('10');
  });

  it('preserves a deliberate deployment budget and other connection settings', () => {
    const config = resolvePrismaConnectionConfig(`${base}?connection_limit=8&pool_timeout=15&sslmode=require&schema=public&options=-c%20statement_timeout%3D5000`);
    const url = new URL(config.url);
    expect(config.connectionLimit).toBe(8);
    expect(config.poolTimeoutSeconds).toBe(15);
    expect(url.username).toBe('app');
    expect(url.password).toBe('private%40password');
    expect(url.hostname).toBe('database');
    expect(url.pathname).toBe('/moh');
    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('options')).toBe('-c statement_timeout=5000');
    expect(url.searchParams.get('schema')).toBe('public');
  });

  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '', '9007199254740992'])(
    'rejects an invalid or unbounded connection budget: %s',
    (value) => expect(() => resolvePrismaConnectionConfig(`${base}?connection_limit=${value}`)).toThrow('connection_limit must be a single positive integer'),
  );

  it('rejects ambiguous duplicate limits and infinite pool waits', () => {
    expect(() => resolvePrismaConnectionConfig(`${base}?connection_limit=5&connection_limit=20`)).toThrow('connection_limit');
    expect(() => resolvePrismaConnectionConfig(`${base}?pool_timeout=0`)).toThrow('pool_timeout');
  });

  it('does not expose credentials in configuration errors', () => {
    for (const value of ['invalid private-password', 'https://app:private-password@database/moh', `${base}?connection_limit=private-password`]) {
      try {
        resolvePrismaConnectionConfig(value);
        throw new Error('Expected invalid configuration');
      } catch (error) {
        expect(String(error)).not.toContain('private-password');
        expect(String(error)).not.toContain('private%40password');
        expect(String(error)).toContain('DATABASE_URL');
      }
    }
  });
});
