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
  verifiedStatus: 'identity',
  verifiedAt: new Date(),
  unverifiedAt: null,
};

const DEV_USERS = [
  {
    phone: '+15550000001',
    username: 'johnlocke',
    usernameIsSet: true,
    name: 'John Locke',
    bio: 'Man of faith. Discipline over drift. I do the work and help the men beside me rise.',
    verifiedStatus: 'manual',
    verifiedAt: new Date(),
    unverifiedAt: null,
  },
  {
    phone: '+15550000002',
    username: 'johncalvin',
    usernameIsSet: true,
    name: 'John Calvin',
    bio: 'Conviction, clarity, and consistency. Hunger for truth, strength, and brotherhood.',
    verifiedStatus: 'identity',
    verifiedAt: new Date(),
    unverifiedAt: null,
  },
  {
    phone: '+15550000003',
    username: 'cslewis',
    usernameIsSet: true,
    name: 'C.S. Lewis',
    bio: 'Courage with humility. Build the habit, keep the promise, sharpen the mind.',
    verifiedStatus: 'none',
    verifiedAt: null,
    unverifiedAt: new Date(),
  },
  {
    phone: '+15550000004',
    username: 'stevejobs',
    usernameIsSet: true,
    name: 'Steve Jobs',
    bio: 'Focus is saying no. Build with excellence. Stay hungry and lead with vision.',
    verifiedStatus: 'manual',
    verifiedAt: new Date(),
    unverifiedAt: null,
  },
  {
    phone: '+15550000005',
    username: 'jackshepherd',
    usernameIsSet: true,
    name: 'Jack Shepherd',
    bio: 'Do the hard thing. Lead when it counts. Brotherhood means responsibility.',
    verifiedStatus: 'none',
    verifiedAt: null,
    unverifiedAt: new Date(),
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

async function ensureUser(user) {
  const byPhone = await prisma.user.findFirst({ where: { phone: user.phone }, select: { id: true } });
  if (byPhone) {
    await prisma.user.update({
      where: { id: byPhone.id },
      data: user,
    });
    return { id: byPhone.id, created: false };
  }

  const byUsername = await userExistsCaseInsensitive(user.username);
  if (byUsername) {
    await prisma.user.update({
      where: { id: byUsername.id },
      data: user,
    });
    return { id: byUsername.id, created: false };
  }

  const created = await prisma.user.create({ data: user });
  return { id: created.id, created: true };
}

async function ensureAdminUser() {
  const res = await ensureUser(DEFAULT_ADMIN);
  if (res.created) console.log('Seeded dev admin user:', DEFAULT_ADMIN.username);
}

async function main() {
  await ensureAdminUser();

  for (const u of DEV_USERS) {
    const res = await ensureUser(u);
    if (res.created) console.log('Seeded dev user:', u.username);
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

