import { ForbiddenException } from '@nestjs/common';
import { GroupAccessService } from './group-access.service';

const roles = ['owner', 'moderator', 'member'] as const;
const statuses = ['active', 'pending', 'banned'] as const;

function makeService(row: { role: string; status: string } | null) {
  const prisma = { communityGroupMember: { findUnique: jest.fn().mockResolvedValue(row) } };
  const read = { assertCanRead: jest.fn().mockResolvedValue(undefined) };
  return { svc: new GroupAccessService(prisma as never, read as never), read };
}

describe('GroupAccessService role matrix', () => {
  it.each(roles.flatMap((role) => statuses.map((status) => [role, status] as const)))('assertModOrOwner %s/%s', async (role, status) => {
    const { svc } = makeService({ role, status });
    const allowed = status === 'active' && role !== 'member';
    if (allowed) await expect(svc.assertModOrOwner('g', 'u')).resolves.toBe(role);
    else await expect(svc.assertModOrOwner('g', 'u')).rejects.toThrow(new ForbiddenException('Not allowed.'));
  });

  it('rejects when there is no membership row', async () => {
    const { svc } = makeService(null);
    await expect(svc.assertModOrOwner('g', 'u')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getMemberOrThrow('g', 'u')).rejects.toThrow('You must be a member of this group.');
  });

  it('getMemberOrThrow requires an active row and honors a custom message', async () => {
    await expect(makeService({ role: 'member', status: 'pending' }).svc.getMemberOrThrow('g', 'u', 'nope')).rejects.toThrow('nope');
    await expect(makeService({ role: 'member', status: 'active' }).svc.getMemberOrThrow('g', 'u')).resolves.toMatchObject({ role: 'member' });
  });

  it('assertRole honors a custom allow-list', async () => {
    const { svc } = makeService({ role: 'owner', status: 'active' });
    await expect(svc.assertRole('g', 'u', ['owner'])).resolves.toBe('owner');
    await expect(makeService({ role: 'moderator', status: 'active' }).svc.assertRole('g', 'u', ['owner'])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('assertCanRead delegates to the single read gate', async () => {
    const { svc, read } = makeService(null);
    await svc.assertCanRead('u', 'g');
    expect(read.assertCanRead).toHaveBeenCalledWith('u', 'g');
  });
});
