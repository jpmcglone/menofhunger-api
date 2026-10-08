import { ForbiddenException } from '@nestjs/common';
import { assertOwnerOrAdmin } from './assert-owner-or-admin';

describe('assertOwnerOrAdmin', () => {
  it('allows the owner and site admins', () => {
    expect(() => assertOwnerOrAdmin({ userId: 'u1' }, 'u1')).not.toThrow();
    expect(() => assertOwnerOrAdmin({ userId: 'a', isSiteAdmin: true }, 'u1')).not.toThrow();
  });
  it('throws the supplied message for anyone else', () => {
    expect(() => assertOwnerOrAdmin({ userId: 'u2' }, 'u1', 'Not your article.')).toThrow(
      new ForbiddenException('Not your article.'),
    );
    expect(() => assertOwnerOrAdmin({ userId: 'u2' }, null)).toThrow(ForbiddenException);
  });
});
