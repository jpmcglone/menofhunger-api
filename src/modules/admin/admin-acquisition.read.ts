import { Prisma, type PrismaClient } from '@prisma/client';
import type { AdminAcquisitionDto } from '../../common/dto';

type Row = { key: string; signups: bigint; verified: bigint };

/** Signups and verified members grouped by write-once signup attribution. Bots and banned users excluded. */
export async function readAdminAcquisition(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  days: number,
  now: Date = new Date(),
): Promise<AdminAcquisitionDto> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const group = (column: 'signupSource' | 'signupCampaign') =>
    prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT COALESCE(${Prisma.raw(`"${column}"`)}, 'unknown') AS key,
             COUNT(*)::bigint AS signups,
             COUNT(*) FILTER (WHERE "verifiedStatus" <> 'none')::bigint AS verified
      FROM "User"
      WHERE "createdAt" >= ${since}
        AND "bannedAt" IS NULL
        AND "isBot" = false
      GROUP BY 1
      ORDER BY signups DESC, key ASC
      LIMIT 50
    `);
  const [bySource, byCampaign, recruiters] = await Promise.all([
    group('signupSource'),
    group('signupCampaign'),
    prisma.$queryRaw<Array<{ cnt: bigint }>>(Prisma.sql`
      SELECT COUNT(DISTINCT "recruitedById")::bigint AS cnt
      FROM "User"
      WHERE "createdAt" >= ${since}
        AND "recruitedById" IS NOT NULL
        AND "bannedAt" IS NULL
        AND "isBot" = false
    `),
  ]);
  const toRows = (rows: Row[]) =>
    rows.map((r) => ({ key: r.key, signups: Number(r.signups), verified: Number(r.verified) }));
  return {
    days,
    since: since.toISOString(),
    asOf: now.toISOString(),
    totalSignups: bySource.reduce((n, r) => n + Number(r.signups), 0),
    totalVerified: bySource.reduce((n, r) => n + Number(r.verified), 0),
    distinctRecruiters: Number(recruiters[0]?.cnt ?? 0),
    bySource: toRows(bySource),
    byCampaign: toRows(byCampaign),
  };
}
