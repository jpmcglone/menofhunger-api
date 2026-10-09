import { Prisma } from '@prisma/client';
import { isNotFound, isSerializationFailure, isUniqueViolation } from './errors';

const err = (code: string) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });

describe('prisma error helpers', () => {
  it('detects unique violations', () => {
    expect(isUniqueViolation(err('P2002'))).toBe(true);
    expect(isUniqueViolation(err('P2025'))).toBe(false);
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
  });
  it('detects not-found', () => {
    expect(isNotFound(err('P2025'))).toBe(true);
    expect(isNotFound(err('P2002'))).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});

describe('isSerializationFailure', () => {
  it('matches the Prisma code and the Postgres message', () => {
    expect(isSerializationFailure({ code: 'P2034' })).toBe(true);
    expect(isSerializationFailure(new Error('ERROR: could not serialize access due to concurrent update'))).toBe(true);
    expect(isSerializationFailure({ code: 'P2002' })).toBe(false);
    expect(isSerializationFailure(undefined)).toBe(false);
  });
});
