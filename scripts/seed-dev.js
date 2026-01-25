/* eslint-disable no-console */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DEFAULT_ADMIN = {
  phone: '+16319436889',
  username: 'jpmcglone',
  usernameIsSet: true,
  name: 'John McGlone',
  bio: 'Christian husband and CEO of Men of Hunger',
  siteAdmin: true,
};

const DEV_USERS = [
  {
    phone: '+15550000001',
    username: 'johnlocke',
    usernameIsSet: true,
    name: 'John Locke',
    bio: 'Man of faith. Discipline over drift. I do the work and help the men beside me rise.',
  },
  {
    phone: '+15550000002',
    username: 'johncalvin',
    usernameIsSet: true,
    name: 'John Calvin',
    bio: 'Conviction, clarity, and consistency. Hunger for truth, strength, and brotherhood.',
  },
  {
    phone: '+15550000003',
    username: 'cslewis',
    usernameIsSet: true,
    name: 'C.S. Lewis',
    bio: 'Courage with humility. Build the habit, keep the promise, sharpen the mind.',
  },
  {
    phone: '+15550000004',
    username: 'stevejobs',
    usernameIsSet: true,
    name: 'Steve Jobs',
    bio: 'Focus is saying no. Build with excellence. Stay hungry and lead with vision.',
  },
  {
    phone: '+15550000005',
    username: 'jackshepherd',
    usernameIsSet: true,
    name: 'Jack Shepherd',
    bio: 'Do the hard thing. Lead when it counts. Brotherhood means responsibility.',
  },
];

async function userExistsCaseInsensitive(username) {
  const normalized = username.toLowerCase();
  const rows =
    await prisma.$queryRaw`
      SELECT "id"
      FROM "User"
      WHERE LOWER("username") = ${normalized}
      LIMIT 1
    `;
  return rows[0] ?? null;
}

async function ensureAdminUser() {
  const byPhone = await prisma.user.findFirst({ where: { phone: DEFAULT_ADMIN.phone }, select: { id: true } });
  if (byPhone) {
    await prisma.user.update({
      where: { id: byPhone.id },
      data: { siteAdmin: true },
    });
    return;
  }

  const byUsername = await userExistsCaseInsensitive(DEFAULT_ADMIN.username);
  if (byUsername) {
    await prisma.user.update({
      where: { id: byUsername.id },
      data: { siteAdmin: true },
    });
    return;
  }

  await prisma.user.create({ data: DEFAULT_ADMIN });
  console.log('Seeded dev admin user:', DEFAULT_ADMIN.username);
}

async function main() {
  await ensureAdminUser();

  for (const u of DEV_USERS) {
    const byPhone = await prisma.user.findFirst({ where: { phone: u.phone }, select: { id: true } });
    if (byPhone) continue;

    const byUsername = await userExistsCaseInsensitive(u.username);
    if (byUsername) continue;

    await prisma.user.create({ data: u });
    console.log('Seeded dev user:', u.username);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

