import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import type { XProfilePreviewDto, XAuthorMetricsDto } from "../../common/dto/integrations.dto";

const count = z.number().int().nonnegative().safe();
const dates = {
  fetchedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
};
const web = z
  .string()
  .url()
  .refine(
    (s) =>
      /^https?:\/\//.test(s) && !new URL(s).username && !new URL(s).password,
  );
const image = web.refine(
  (s) =>
    new URL(s).protocol === "https:" && new URL(s).hostname === "pbs.twimg.com",
);
const profileSchema = z
  .object({
    id: z.string().regex(/^\d+$/),
    username: z.string().regex(/^[a-zA-Z0-9_]{1,15}$/),
    name: z.string().max(200),
    description: z.string().max(2000).nullable(),
    avatarUrl: image.nullable(),
    bannerUrl: image.nullable(),
    websiteUrl: web.nullable(),
    verified: z.boolean(),
    followers: count.nullable(),
    following: count.nullable(),
    ...dates,
  })
  .strict();
const metricsSchema = z
  .object({
    postId: z.string(),
    externalUrl: z.string().regex(/^https:\/\/x.com\/i\/status\/\d+$/),
    likes: count.optional(),
    replies: count.optional(),
    reposts: count.optional(),
    quotes: count.optional(),
    impressions: count.optional(),
    ...dates,
  })
  .strict();

/** Redis may disappear; a fresh normalized snapshot must not require another paid read.
 * No access-time writes or background refresh: only an intentional eligible view can refresh.
 * Callers MUST check local visibility/ownership before consulting this public cache.
 */
@Injectable()
export class XPublicSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  async profile(
    identity: string | null,
    handle: string,
  ): Promise<XProfilePreviewDto | null> {
    const row = await this.prisma.integrationPublicSnapshot.findFirst({
      where: {
        kind: "x-profile",
        ...(identity ? { identity } : { handle }),
        expiresAt: { gt: new Date() },
      },
      orderBy: { fetchedAt: "desc" },
    });
    const parsed = profileSchema.safeParse(row?.payload);
    return parsed.success &&
      row?.identity === parsed.data.id &&
      (!identity || parsed.data.id === identity) &&
      parsed.data.username.toLowerCase() === handle &&
      this.fresh(parsed.data)
      ? parsed.data
      : null;
  }
  async metrics(
    identity: string,
    postId: string,
  ): Promise<XAuthorMetricsDto | null> {
    const row = await this.prisma.integrationPublicSnapshot.findUnique({
      where: { key: `x-metrics:${identity}` },
    });
    const parsed = metricsSchema.safeParse(row?.payload);
    return row &&
      row.expiresAt > new Date() &&
      parsed.success &&
      parsed.data.postId === postId &&
      parsed.data.externalUrl === `https://x.com/i/status/${identity}` &&
      this.fresh(parsed.data)
      ? parsed.data
      : null;
  }
  async saveProfile(value: XProfilePreviewDto) {
    const data = profileSchema.parse(value);
    await this.save("x-profile", data.id, data.username.toLowerCase(), data);
  }
  async saveMetrics(identity: string, value: XAuthorMetricsDto) {
    await this.save("x-metrics", identity, null, metricsSchema.parse(value));
  }
  async invalidate(kind: "x-profile" | "x-metrics", identity: string) {
    await this.prisma.integrationPublicSnapshot.deleteMany({
      where: { key: `${kind}:${identity}` },
    });
  }
  async prune() {
    // Bounded deletion avoids a large maintenance transaction after downtime.
    await this.prisma
      .$executeRaw`DELETE FROM "IntegrationPublicSnapshot" WHERE key IN
      (SELECT key FROM "IntegrationPublicSnapshot" WHERE "expiresAt"<=NOW() ORDER BY "expiresAt" LIMIT 1000)`;
  }
  private fresh(value: { fetchedAt: string; expiresAt: string }) {
    const start = Date.parse(value.fetchedAt),
      end = Date.parse(value.expiresAt),
      now = Date.now();
    return start <= now && end > now && end - start <= 86_400_000;
  }
  private async save(
    kind: string,
    identity: string,
    handle: string | null,
    payload: XProfilePreviewDto | XAuthorMetricsDto,
  ) {
    if (!this.fresh(payload)) return;
    const data = {
      kind,
      identity,
      handle,
      payload,
      fetchedAt: new Date(payload.fetchedAt),
      expiresAt: new Date(payload.expiresAt),
    };
    await this.prisma.integrationPublicSnapshot.upsert({
      where: { key: `${kind}:${identity}` },
      create: { key: `${kind}:${identity}`, ...data },
      update: data,
    });
  }
}
