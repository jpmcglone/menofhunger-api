import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ZodError } from 'zod';
import { RedisKeys } from '../redis/redis-keys';
import { ProfileLinksWriteService } from './profile-links-write.service';

type Row = {
  id: string;
  userId: string;
  url: string;
  title: string;
  position: number;
  legacyField: string | null;
  grandfathered: boolean;
};

/** Minimal in-memory Prisma double covering the queries the write service issues. */
function makeFake(opts: { verifiedStatus?: string; rows?: Row[] } = {}) {
  const rows: Row[] = [...(opts.rows ?? [])];
  const user: Record<string, unknown> = {
    id: 'u1',
    username: 'Alice',
    verifiedStatus: opts.verifiedStatus ?? 'manual',
    website: null,
    youtubeUrl: null,
    rumbleUrl: null,
    linkedinUrl: null,
    showXFollowerCount: false,
  };
  let seq = 0;
  const match = (r: Row, where: any): boolean => {
    if (where.userId && r.userId !== where.userId) return false;
    if (where.id !== undefined) {
      if (typeof where.id === 'string' && r.id !== where.id) return false;
      if (where.id?.notIn && where.id.notIn.includes(r.id)) return false;
      if (where.id?.not && r.id === where.id.not) return false;
    }
    if (where.legacyField !== undefined) {
      if (typeof where.legacyField === 'string' && r.legacyField !== where.legacyField) return false;
      if (where.legacyField?.not === null && r.legacyField === null) return false;
    }
    return true;
  };
  const profileLink = {
    findMany: jest.fn(async ({ where }: any) =>
      rows.filter((r) => match(r, where)).sort((a, b) => a.position - b.position),
    ),
    findFirst: jest.fn(async ({ where }: any) => rows.find((r) => match(r, where)) ?? null),
    deleteMany: jest.fn(async ({ where }: any) => {
      for (const r of rows.filter((x) => match(x, where))) rows.splice(rows.indexOf(r), 1);
    }),
    delete: jest.fn(async ({ where }: any) => {
      rows.splice(rows.findIndex((r) => r.id === where.id), 1);
    }),
    update: jest.fn(async ({ where, data }: any) => {
      Object.assign(rows.find((r) => r.id === where.id)!, data);
    }),
    create: jest.fn(async ({ data }: any) => {
      rows.push({ id: `new${++seq}`, legacyField: null, ...data });
    }),
  };
  const prisma: any = {
    profileLink,
    user: {
      findUnique: jest.fn(async () => ({ ...user })),
      update: jest.fn(async ({ data }: any) => Object.assign(user, data)),
    },
    $transaction: jest.fn(async (cb: any) => cb(prisma)),
  };
  const cache = { invalidateForUser: jest.fn(async () => undefined) };
  const realtime = { emitPublicProfileUpdated: jest.fn(async () => undefined) };
  const redis = { del: jest.fn(async () => 1) };
  const auth = { bustSessionCachesForUser: jest.fn(async () => undefined) };
  const service = new ProfileLinksWriteService(prisma, cache as any, realtime as any, redis as any, auth as any);
  return { service, rows, user, prisma, cache, realtime, redis, auth };
}

const row = (over: Partial<Row> & { id: string; url: string }): Row => ({
  userId: 'u1',
  title: over.title ?? 'T',
  position: 0,
  legacyField: null,
  grandfathered: false,
  ...over,
});

describe('ProfileLinksWriteService.replaceLinks', () => {
  it('updates existing ids in place, deletes missing ones, creates id-less ones', async () => {
    const f = makeFake({
      rows: [
        row({ id: 'a', url: 'https://a.example/', position: 0, title: 'A' }),
        row({ id: 'b', url: 'https://b.example/', position: 1, title: 'B' }),
        row({ id: 'c', url: 'https://c.example/', position: 2, title: 'C' }),
      ],
    });
    await f.service.replaceLinks('u1', {
      links: [
        { id: 'c', url: 'https://c.example/' },
        { url: 'new.example', title: ' New ' },
        { id: 'a', url: 'https://a.example/', title: 'Renamed' },
      ],
    });
    expect(f.rows.map((r) => r.id).sort()).toEqual(['a', 'c', 'new1']);
    const byId = Object.fromEntries(f.rows.map((r) => [r.id, r]));
    expect(byId.c).toMatchObject({ position: 0, title: 'C' }); // stable id, title preserved
    expect(byId.new1).toMatchObject({ position: 1, title: 'New', url: 'https://new.example/' });
    expect(byId.a).toMatchObject({ position: 2, title: 'Renamed' });
  });

  it('defaults the title to the host when omitted', async () => {
    const f = makeFake();
    await f.service.replaceLinks('u1', { links: [{ url: 'https://www.example.com/x' }] });
    expect(f.rows[0].title).toBe('example.com');
  });

  it('rejects more than 10 links, unknown keys, duplicate URLs, and unknown ids', async () => {
    const f = makeFake({ rows: [row({ id: 'a', url: 'https://a.example/' })] });
    const many = Array.from({ length: 11 }, (_, i) => ({ url: `https://s${i}.example` }));
    await expect(f.service.replaceLinks('u1', { links: many })).rejects.toBeInstanceOf(ZodError);
    await expect(f.service.replaceLinks('u1', { links: [], extra: 1 })).rejects.toBeInstanceOf(ZodError);
    await expect(
      f.service.replaceLinks('u1', { links: [{ url: 'https://x.example/a' }, { url: 'http://www.X.example/a/' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.service.replaceLinks('u1', { links: [{ id: 'nope', url: 'https://x.example' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.service.replaceLinks('u1', { links: [{ url: 'https://bit.ly/x' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.rows).toHaveLength(1); // validation failures wrote nothing
  });

  it('blocks unverified owners from adding or changing links but allows reorder/retitle/remove', async () => {
    const f = makeFake({
      verifiedStatus: 'none',
      rows: [
        row({ id: 'a', url: 'https://a.example/', position: 0, grandfathered: true }),
        row({ id: 'b', url: 'https://b.example/', position: 1, grandfathered: true }),
      ],
    });
    await expect(
      f.service.replaceLinks('u1', { links: [{ id: 'a', url: 'https://a.example/' }, { url: 'https://new.example' }] }),
    ).rejects.toThrow('Custom links are for verified members.');
    await expect(
      f.service.replaceLinks('u1', { links: [{ id: 'a', url: 'https://other.example/' }] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.rows).toHaveLength(2);

    await f.service.replaceLinks('u1', {
      links: [{ id: 'b', url: 'https://b.example/', title: 'Bee' }],
    });
    expect(f.rows.map((r) => r.id)).toEqual(['b']);
    expect(f.rows[0]).toMatchObject({ title: 'Bee', position: 0, grandfathered: true });
  });

  it('clears grandfathered when a verified owner changes the URL', async () => {
    const f = makeFake({ rows: [row({ id: 'a', url: 'https://a.example/', grandfathered: true, title: 'a.example' })] });
    await f.service.replaceLinks('u1', { links: [{ id: 'a', url: 'https://z.example' }] });
    expect(f.rows[0]).toMatchObject({ url: 'https://z.example/', grandfathered: false, title: 'z.example' });
  });

  it('mirrors legacy columns in the same transaction (null when the row is gone)', async () => {
    const f = makeFake({
      rows: [
        row({ id: 'w', url: 'https://site.example/', legacyField: 'website', position: 0 }),
        row({ id: 'y', url: 'https://www.youtube.com/@a', legacyField: 'youtube', position: 1 }),
      ],
    });
    await f.service.replaceLinks('u1', { links: [{ id: 'w', url: 'https://site2.example' }] });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.user).toMatchObject({
      website: 'https://site2.example/',
      youtubeUrl: null,
      rumbleUrl: null,
      linkedinUrl: null,
    });
  });

  it('invalidates caches and emits the public profile update after a write', async () => {
    const f = makeFake();
    await f.service.replaceLinks('u1', { links: [{ url: 'https://a.example' }] });
    expect(f.cache.invalidateForUser).toHaveBeenCalledWith({ id: 'u1', username: 'Alice' });
    expect(f.redis.del).toHaveBeenCalledWith(RedisKeys.linksPage('Alice'));
    expect(f.realtime.emitPublicProfileUpdated).toHaveBeenCalledWith('u1');
    expect(f.auth.bustSessionCachesForUser).toHaveBeenCalledWith('u1');
  });
});

describe('ProfileLinksWriteService.setLegacyFields (shim)', () => {
  it('creates a legacy row at the end and mirrors the column', async () => {
    const f = makeFake({ rows: [row({ id: 'a', url: 'https://a.example/', position: 3 })] });
    await f.service.setLegacyFields('u1', { youtube: 'https://www.youtube.com/@me' });
    expect(f.rows[1]).toMatchObject({ legacyField: 'youtube', title: 'YouTube', position: 4, grandfathered: false });
    expect(f.user.youtubeUrl).toBe('https://www.youtube.com/@me');
  });

  it('updates the existing legacy row in place', async () => {
    const f = makeFake({
      rows: [row({ id: 'w', url: 'https://old.example/', legacyField: 'website', title: 'old.example', grandfathered: true })],
    });
    await f.service.setLegacyFields('u1', { website: 'https://new.example/' });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({ id: 'w', url: 'https://new.example/', title: 'new.example', grandfathered: false });
    expect(f.user.website).toBe('https://new.example/');
  });

  it('deletes the row on an empty value and nulls the mirror', async () => {
    const f = makeFake({ rows: [row({ id: 'r', url: 'https://rumble.com/user/a', legacyField: 'rumble' })] });
    f.user.rumbleUrl = 'https://rumble.com/user/a';
    await f.service.setLegacyFields('u1', { rumble: null });
    expect(f.rows).toHaveLength(0);
    expect(f.user.rumbleUrl).toBeNull();
  });

  it('gates unverified owners: 403 on add/change, no-op on unchanged, removal allowed', async () => {
    const f = makeFake({
      verifiedStatus: 'none',
      rows: [row({ id: 'w', url: 'https://site.example/', legacyField: 'website', grandfathered: true })],
    });
    await expect(f.service.setLegacyFields('u1', { linkedin: 'https://www.linkedin.com/in/a' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(f.service.setLegacyFields('u1', { website: 'https://changed.example/' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await f.service.setLegacyFields('u1', { website: 'https://www.site.example' });
    expect(f.realtime.emitPublicProfileUpdated).not.toHaveBeenCalled();
    expect(f.prisma.user.update).not.toHaveBeenCalled();

    await f.service.setLegacyFields('u1', { website: '' });
    expect(f.rows).toHaveLength(0);
  });

  it('admin edits skip the verification gate', async () => {
    const f = makeFake({ verifiedStatus: 'none' });
    await f.service.setLegacyFields('u1', { website: 'https://admin.example/' }, { skipVerifyGate: true });
    expect(f.rows).toHaveLength(1);
    expect(f.user.website).toBe('https://admin.example/');
  });

  it('rejects unsafe URLs and honors emit:false', async () => {
    const f = makeFake();
    await expect(f.service.setLegacyFields('u1', { website: 'https://bit.ly/x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await f.service.setLegacyFields('u1', { website: 'https://ok.example' }, { emit: false });
    expect(f.cache.invalidateForUser).toHaveBeenCalled();
    expect(f.realtime.emitPublicProfileUpdated).not.toHaveBeenCalled();
  });
});

describe('ProfileLinksWriteService.setShowXFollowerCount', () => {
  it('saves the switch and clears the links page cache', async () => {
    const f = makeFake();
    await f.service.setShowXFollowerCount('u1', true);
    expect(f.user.showXFollowerCount).toBe(true);
    expect(f.redis.del).toHaveBeenCalledWith(RedisKeys.linksPage('Alice'));
  });
});
