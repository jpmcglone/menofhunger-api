import { NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";

export async function findUserByUsernameOrThrow(prisma: PrismaService, usernameRaw: string) {
  const username = usernameRaw.trim().toLowerCase();
  const user = await prisma.user.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
  });
  if (!user) throw new NotFoundException("User not found.");
  return user;
}
