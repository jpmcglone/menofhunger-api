/** Run with an explicitly selected DATABASE_URL. Defaults to a read-only count; --apply provisions. */
import { PrismaClient } from '@prisma/client';
import { provisionDefaultChannels } from '../src/modules/group-channels/channel-provisioning';
import { lockChannelGroup } from '../src/modules/group-channels/channel-lifecycle';

async function main() {
  const prisma = new PrismaClient();
  const apply = process.argv.includes('--apply');
  let cursor: string | undefined;
  let checked = 0;
  let missing = 0;
  try {
    for (;;) {
      const groups = await prisma.communityGroup.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, createdByUserId: true, channels: { where: { defaultPurpose: { not: null } }, select: { defaultPurpose: true } } } });
      if (!groups.length) break;
      for (const group of groups) {
        checked++;
        missing += 3 - group.channels.length;
        if (apply) await prisma.$transaction(async tx => {
          await lockChannelGroup(tx, group.id);
          await provisionDefaultChannels(tx, group.id, group.createdByUserId);
        });
      }
      cursor = groups.at(-1)!.id;
    }
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', groups: checked, missingDefaults: missing }));
  } finally { await prisma.$disconnect(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Backfill failed.'); process.exitCode = 1; });
