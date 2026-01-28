/* eslint-disable no-console */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DEFAULT_USER = {
  id: 'cmkq6cw1b00019rssnl1pm85t',
  phone: '+16319436889',
  username: 'jpmcglone',
  usernameIsSet: true,
  name: 'John McGlone',
  bio: 'Christian husband and CEO of Men of Hunger',
  siteAdmin: true,
  verifiedStatus: 'identity',
  verifiedAt: new Date(),
  unverifiedAt: null,
};

async function main() {
  // Idempotent: if it exists by id, username (case-insensitive), or phone, do nothing.
  const byId = await prisma.user.findUnique({ where: { id: DEFAULT_USER.id }, select: { id: true } });
  if (byId) {
    await prisma.user.update({ where: { id: DEFAULT_USER.id }, data: { siteAdmin: true } });
    return;
  }

  const byPhone = await prisma.user.findFirst({ where: { phone: DEFAULT_USER.phone }, select: { id: true } });
  if (byPhone) {
    await prisma.user.update({ where: { id: byPhone.id }, data: { siteAdmin: true } });
    return;
  }

  const normalized = DEFAULT_USER.username.toLowerCase();
  const byUsername =
    (
      await prisma.$queryRaw`
        SELECT "id"
        FROM "User"
        WHERE LOWER("username") = ${normalized}
        LIMIT 1
      `
    )[0] ?? null;
  if (byUsername) {
    await prisma.user.update({ where: { id: byUsername.id }, data: { siteAdmin: true } });
    return;
  }

  await prisma.user.create({ data: DEFAULT_USER });
  console.log('Seeded default prod user:', DEFAULT_USER.username);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

