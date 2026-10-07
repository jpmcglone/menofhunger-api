import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export type ForYouScannedRow = {
  id: string;
  userId: string;
  parentId: string | null;
  communityGroupId: string | null;
  createdAt: Date;
  trendingScore: number | null;
};

export type ForYouCandidate = ForYouScannedRow & {
  followingUnseen: boolean;
  friendEngaged: boolean;
  secondDegree: boolean;
  secondDegreePaths: number;
  memberGroup: boolean;
  openFollowGroup: boolean;
  lastFriendEngagementAt: Date | null;
};

export type ForYouLane =
  | "following"
  | "friend"
  | "secondDegree"
  | "memberGroup"
  | "openFollowGroup"
  | "discovery";

export function addForYouRows(
  candidateById: Map<string, ForYouCandidate>,
  secondDegreePathCountByAuthor: Map<string, number>,
  rows: ForYouScannedRow[],
  lane: ForYouLane,
): void {
  for (const row of rows) {
    const existing = candidateById.get(row.id);
    if (existing) {
      if (lane === "following") existing.followingUnseen = true;
      if (lane === "friend") existing.friendEngaged = true;
      if (lane === "secondDegree") {
        existing.secondDegree = true;
        existing.secondDegreePaths = Math.max(
          existing.secondDegreePaths,
          secondDegreePathCountByAuthor.get(row.userId) ?? 1,
        );
      }
      if (lane === "memberGroup") existing.memberGroup = true;
      if (lane === "openFollowGroup") existing.openFollowGroup = true;
      continue;
    }
    candidateById.set(row.id, {
      ...row,
      followingUnseen: lane === "following",
      friendEngaged: lane === "friend",
      secondDegree: lane === "secondDegree",
      secondDegreePaths:
        lane === "secondDegree"
          ? (secondDegreePathCountByAuthor.get(row.userId) ?? 1)
          : 0,
      memberGroup: lane === "memberGroup",
      openFollowGroup: lane === "openFollowGroup",
      lastFriendEngagementAt: null,
    });
  }
}

const SCAN_SELECT = {
  id: true,
  userId: true,
  parentId: true,
  communityGroupId: true,
  createdAt: true,
  trendingScore: true,
} as const;

export async function loadForYouNetworkCandidates(params: {
  prisma: PrismaService;
  baseWhere: Prisma.PostWhereInput;
  commonWhere: Prisma.PostWhereInput;
  servedWhere: Prisma.PostWhereInput[];
  followingCandidateIds: string[];
  viewedPostIds: string[];
  friendEngagedPostIds: string[];
  secondDegreeAuthorIds: string[];
  memberGroupIds: string[];
  viewerCanReadOpenGroups: boolean;
  followedSince: Date;
  secondDegreeSince: Date;
  groupSince: Date;
  scanTake: number;
  friendTake: number;
  secondDegreeTake: number;
  secondDegreePathCountByAuthor: Map<string, number>;
  trendingScanned: ForYouScannedRow[];
  chronoScanned: ForYouScannedRow[];
}): Promise<{
  candidateById: Map<string, ForYouCandidate>;
  followedOverflow: boolean;
  friendOverflow: boolean;
  secondDegreeOverflow: boolean;
  memberGroupOverflow: boolean;
  openFollowGroupOverflow: boolean;
}> {
  const {
    prisma,
    baseWhere,
    commonWhere,
    servedWhere,
    followingCandidateIds,
    viewedPostIds,
    friendEngagedPostIds,
    secondDegreeAuthorIds,
    memberGroupIds,
    viewerCanReadOpenGroups,
    followedSince,
    secondDegreeSince,
    groupSince,
    scanTake,
    friendTake,
    secondDegreeTake,
    secondDegreePathCountByAuthor,
    trendingScanned,
    chronoScanned,
  } = params;

  const [
    followedRowsRaw,
    friendRowsRaw,
    secondDegreeRowsRaw,
    memberGroupRowsRaw,
    openFollowGroupRowsRaw,
  ] = await Promise.all([
    followingCandidateIds.length > 0
      ? (prisma.post.findMany({
          where: {
            AND: [
              baseWhere,
              ...servedWhere,
              { userId: { in: followingCandidateIds } },
              { createdAt: { gte: followedSince } },
              ...(viewedPostIds.length > 0
                ? [{ id: { notIn: viewedPostIds } }]
                : []),
            ],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: scanTake + 1,
          select: SCAN_SELECT,
        }) as Promise<ForYouScannedRow[]>)
      : Promise.resolve([] as ForYouScannedRow[]),
    friendEngagedPostIds.length > 0
      ? (prisma.post.findMany({
          where: {
            AND: [
              baseWhere,
              ...servedWhere,
              { id: { in: friendEngagedPostIds } },
            ],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: friendTake + 1,
          select: SCAN_SELECT,
        }) as Promise<ForYouScannedRow[]>)
      : Promise.resolve([] as ForYouScannedRow[]),
    secondDegreeAuthorIds.length > 0
      ? (prisma.post.findMany({
          where: {
            AND: [
              baseWhere,
              ...servedWhere,
              { userId: { in: secondDegreeAuthorIds } },
              { createdAt: { gte: secondDegreeSince } },
            ],
          },
          orderBy: [
            { trendingScore: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
          ],
          take: secondDegreeTake + 1,
          select: SCAN_SELECT,
        }) as Promise<ForYouScannedRow[]>)
      : Promise.resolve([] as ForYouScannedRow[]),
    memberGroupIds.length > 0
      ? (prisma.post.findMany({
          where: {
            AND: [
              commonWhere,
              ...servedWhere,
              { communityGroupId: { in: memberGroupIds } },
              { createdAt: { gte: groupSince } },
            ],
          },
          orderBy: [
            { trendingScore: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
          ],
          take: scanTake + 1,
          select: SCAN_SELECT,
        }) as Promise<ForYouScannedRow[]>)
      : Promise.resolve([] as ForYouScannedRow[]),
    viewerCanReadOpenGroups && followingCandidateIds.length > 0
      ? (prisma.post.findMany({
          where: {
            AND: [
              commonWhere,
              ...servedWhere,
              { userId: { in: followingCandidateIds } },
              memberGroupIds.length > 0
                ? { communityGroupId: { notIn: memberGroupIds } }
                : { communityGroupId: { not: null } },
              {
                communityGroup: {
                  is: { deletedAt: null, joinPolicy: "open" },
                },
              },
              { createdAt: { gte: groupSince } },
            ],
          },
          orderBy: [
            { trendingScore: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
          ],
          take: scanTake + 1,
          select: SCAN_SELECT,
        }) as Promise<ForYouScannedRow[]>)
      : Promise.resolve([] as ForYouScannedRow[]),
  ]);

  const followedOverflow = followedRowsRaw.length > scanTake;
  const friendOverflow = friendRowsRaw.length > friendTake;
  const secondDegreeOverflow = secondDegreeRowsRaw.length > secondDegreeTake;
  const memberGroupOverflow = memberGroupRowsRaw.length > scanTake;
  const openFollowGroupOverflow = openFollowGroupRowsRaw.length > scanTake;
  const followedRows = followedRowsRaw.slice(0, scanTake);
  const friendRows = friendRowsRaw.slice(0, friendTake);
  const secondDegreeRows = secondDegreeRowsRaw.slice(0, secondDegreeTake);
  const memberGroupRows = memberGroupRowsRaw.slice(0, scanTake);
  const openFollowGroupRows = openFollowGroupRowsRaw.slice(0, scanTake);

  const candidateById = new Map<string, ForYouCandidate>();
  addForYouRows(candidateById, secondDegreePathCountByAuthor, followedRows, "following");
  addForYouRows(candidateById, secondDegreePathCountByAuthor, friendRows, "friend");
  addForYouRows(candidateById, secondDegreePathCountByAuthor, secondDegreeRows, "secondDegree");
  addForYouRows(candidateById, secondDegreePathCountByAuthor, memberGroupRows, "memberGroup");
  addForYouRows(candidateById, secondDegreePathCountByAuthor, openFollowGroupRows, "openFollowGroup");
  addForYouRows(candidateById, secondDegreePathCountByAuthor, trendingScanned, "discovery");
  addForYouRows(candidateById, secondDegreePathCountByAuthor, chronoScanned, "discovery");

  return {
    candidateById,
    followedOverflow,
    friendOverflow,
    secondDegreeOverflow,
    memberGroupOverflow,
    openFollowGroupOverflow,
  };
}
