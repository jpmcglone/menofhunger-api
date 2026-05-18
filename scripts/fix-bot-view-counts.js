/* eslint-disable no-console */
/**
 * One-off retroactive fix: remove PostView rows created by bot users (e.g. Marv)
 * and decrement the corresponding Post.viewerCount / weightedViewCount.
 *
 * Each bot PostView was seeded with weight=1 (LOGGED_IN_VIEW_WEIGHT).
 *
 * Run from menofhunger-api/:
 *   node scripts/fix-bot-view-counts.js
 *
 * The script is idempotent — running it twice is safe.
 */

const { PrismaClient } = require('@prisma/client');

const LOGGED_IN_VIEW_WEIGHT = 1;

const prisma = new PrismaClient();

async function main() {
  // Find all PostView rows where the viewer is a bot.
  const botViews = await prisma.postView.findMany({
    where: {
      user: { isBot: true },
    },
    select: { postId: true, userId: true },
  });

  if (botViews.length === 0) {
    console.log('No bot PostView rows found — nothing to fix.');
    return;
  }

  // Group by postId so we can decrement each post once.
  const countByPost = new Map();
  for (const { postId } of botViews) {
    countByPost.set(postId, (countByPost.get(postId) ?? 0) + 1);
  }

  console.log(
    `Found ${botViews.length} bot view row(s) across ${countByPost.size} post(s). Fixing…`,
  );

  // Collect the (postId, userId) pairs to delete.
  const toDelete = botViews.map(({ postId, userId }) => ({ postId, userId }));

  let deleted = 0;
  let updated = 0;

  // Process each affected post in a transaction.
  for (const [postId, count] of countByPost.entries()) {
    const postUserIds = toDelete
      .filter((r) => r.postId === postId)
      .map((r) => r.userId);

    await prisma.$transaction(async (tx) => {
      const del = await tx.postView.deleteMany({
        where: {
          postId,
          userId: { in: postUserIds },
        },
      });
      deleted += del.count;

      if (del.count > 0) {
        await tx.post.update({
          where: { id: postId },
          data: {
            viewerCount: { decrement: del.count },
            weightedViewCount: { decrement: del.count * LOGGED_IN_VIEW_WEIGHT },
          },
        });
        updated++;
      }
    });
  }

  console.log(`Done. Deleted ${deleted} bot view row(s); updated ${updated} post(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
