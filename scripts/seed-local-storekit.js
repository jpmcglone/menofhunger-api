/* eslint-disable no-console */
// Usage: NODE_ENV=development node --env-file=.env scripts/seed-local-storekit.js
const { PrismaClient } = require("@prisma/client");
const fixture = {
  id: "local-storekit-tester",
  phone: "+15550000991",
  username: "storekit_tester",
};
async function main() {
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (
    process.env.NODE_ENV !== "development" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(host)
  ) {
    throw new Error(
      "Fixture seeding requires NODE_ENV=development and a loopback database.",
    );
  }
  const prisma = new PrismaClient();
  try {
    const matches = await prisma.user.findMany({
      where: {
        OR: [
          { id: fixture.id },
          { phone: fixture.phone },
          { username: { equals: fixture.username, mode: "insensitive" } },
        ],
      },
    });
    if (
      matches.some(
        (u) =>
          u.id !== fixture.id ||
          u.phone !== fixture.phone ||
          u.username !== fixture.username,
      )
    ) {
      throw new Error("Fixture identity collision; no account was changed.");
    }
    const existing = matches[0];
    if (
      existing &&
      (existing.stripeSubscriptionId ||
        existing.appleOriginalTransactionId ||
        existing.appleSandboxOriginalTransactionId)
    ) {
      throw new Error(
        "Fixture has external billing records; refusing to reset.",
      );
    }
    const otherGrants = await prisma.subscriptionGrant.count({
      where: {
        userId: fixture.id,
        id: { not: `local-storekit:${fixture.id}` },
        revokedAt: null,
        endsAt: { gt: new Date() },
      },
    });
    if (otherGrants)
      throw new Error(
        "Fixture has unrelated active grants; refusing to reset.",
      );
    await prisma.$transaction(async (tx) => {
      await tx.user.upsert({
        where: { id: fixture.id },
        create: {
          ...fixture,
          name: "StoreKit Local Tester",
          usernameIsSet: true,
          verifiedStatus: "manual",
          verifiedAt: new Date(),
          birthdate: new Date("1990-01-01"),
          menOnlyConfirmed: true,
          heardAboutUs: "prefer_not",
          interests: ["fitness"],
        },
        update: {
          verifiedStatus: "manual",
          verifiedAt: new Date(),
          premium: false,
          premiumPlus: false,
        },
      });
      await tx.subscriptionGrant.deleteMany({
        where: { id: `local-storekit:${fixture.id}`, userId: fixture.id },
      });
    });
    console.log(
      "Local fixture ready: @storekit_tester / +15550000991 / development code 000000. Verified, no subscription. Clear Xcode transactions before relaunching.",
    );
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
